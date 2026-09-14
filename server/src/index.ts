import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  AGENT_SHADES, BIND_HOST, DEFAULT_PORT, DEV_PAGE_PORT, WS_PATH,
  type AgentDiff, type AgentShade, type AsideView, type BlockedView, type FeedEntry,
  type FeedPage, type FileContent, type HerdrRuleState, type ServerEvent, type SettingsView,
  type SubagentsView, type UsageView,
} from '@harness/shared';
import { Aside } from './aside.js';
import { Board } from './board.js';
import { claudeFiles, installClaudeFiles } from './claudeFiles.js';
import { buildAgentDiff, readTouchedFile, touchedPaths } from './diff.js';
import { Herdr } from './herdr.js';
import { herdrRuleState, installHerdrRule, type HerdrRuleOutcome } from './herdrRules.js';
import { History } from './history.js';
import { log, logError, logStart } from './log.js';
import {
  HEALTH_PATH, claim, openBrowser, pageOf, release, running, shouldOpen, urlFor, type Health,
} from './instance.js';
import { admits } from './origin.js';
import { Projects } from './projects.js';
import { rulesAreDefault, rulesText, setRules, startArgs } from './rules.js';
import { Transcripts, feedTurns, subagentPathFor, subagentRows } from './transcript.js';
import { Usage } from './usage.js';

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/**
 * Parsed before anything is constructed, because `stop`, `init` and `--version`
 * answer and exit — none of them wants a Fastify instance, a Herdr socket or a
 * registered static root behind them.
 *
 * `allowPositionals` is not optional here: without it `parseArgs` THROWS on
 * `harness stop` rather than ignoring it.
 */
const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string' },
    'no-open': { type: 'boolean', default: false },
    version: { type: 'boolean', default: false },
    /** Replaces a file `init` would otherwise keep, including one we did not write. */
    force: { type: 'boolean', default: false },
  },
  allowPositionals: true,
});

if (values.version) {
  console.log(packageVersion() ?? 'unknown');
  process.exit(0);
}

const command = positionals[0];
if (command === 'init') {
  runInit(values.force);
  process.exit(0);
} else if (command === 'stop') {
  await runStop();
  process.exit(0);
} else if (command !== undefined) {
  console.error(`[harness] not a command: ${command}`);
  console.error('[harness] usage: harness [--port <n>] [--no-open] | harness init [--force] | harness stop | harness --version');
  process.exit(1);
}

/**
 * Puts the files the agents are told about where Claude Code reads them, and
 * merges our one detection rule into Herdr's manifest.
 *
 * Never clobbers by default. These are the human's own files in the human's own
 * home, and an overwrite is discovered later, by something behaving differently
 * for no visible reason.
 */
function runInit(force: boolean): void {
  for (const f of installClaudeFiles(force)) {
    const note = f.outcome === 'kept' ? ' — yours differs, use --force to replace' : '';
    console.log(`[harness] ${f.outcome.padEnd(9)} ${f.path}${note}`);
  }

  const { outcome, state } = installHerdrRule(force);
  console.log(`[harness] herdr: ${herdrRuleNote(outcome, state)}`);
  if (outcome === 'wrote') {
    console.log('[harness] this file shadows Herdr\'s own updates — re-run `harness init` to refresh it');
  }
}

/**
 * One sentence for both the terminal and the browser. Three of the five
 * outcomes change nothing, so the sentence IS the result — a caller that drops
 * it leaves a button that appears to do nothing at all.
 */
function herdrRuleNote(outcome: HerdrRuleOutcome, state: HerdrRuleState): string {
  switch (outcome) {
    case 'wrote':
      return `wrote ${state.path}${state.remoteVersion ? `, merged from remote ${state.remoteVersion}` : ''}`;
    case 'kept':
      return `kept the override already at ${state.path} — it is not ours, so replacing it needs force`;
    case 'upstream':
      return state.installed && state.ours
        ? `Herdr detects this dialog itself now — delete ${state.path}, which is still shadowing its manifest`
        : 'Herdr detects this dialog itself now, so no override is needed';
    case 'no-remote':
      return 'Herdr has not fetched a claude manifest yet, so there is nothing to merge into';
    case 'unavailable':
      return 'the detection rule is not beside this build — run `npm run build`';
  }
}

/**
 * `running()` rather than the lockfile's pid, which is the whole point: it
 * probes the recorded port before believing anything, so a stale lock left by a
 * crash cannot make this kill an unrelated process that inherited the pid.
 */
async function runStop(): Promise<void> {
  const it = await running();
  if (!it) {
    console.log('[harness] not running');
    return;
  }
  // Asked over HTTP rather than signalled, because only the route broadcasts:
  // viewers are told the cockpit is ending and close their own tabs, where a
  // SIGTERM leaves them pointing at a dead port forever. The signal cannot be
  // taught to do this — `tsx watch` reloads the dev server with the same one,
  // so `shutdown` must stay silent on it. It remains the escalation for a
  // harness that has stopped answering, which is the one case `running()`
  // probing the port a moment ago does not rule out.
  try {
    if ((await fetch(`${urlFor(it.port)}/api/quit`, { method: 'POST' })).ok) {
      console.log(`[harness] stopped harness on ${it.port}`);
      return;
    }
  } catch { /* wedged or gone; the signal below is the answer either way */ }

  try {
    process.kill(it.pid, 'SIGTERM');
  } catch (err) {
    // It answered a moment ago and is gone now, or belongs to another user.
    // Either way this command's whole point is being gentler than `pkill`, so
    // it says what happened rather than throwing a stack at someone.
    const code = (err as { code?: string }).code;
    console.error(`[harness] could not stop pid ${it.pid} on ${it.port}: ${code ?? (err as Error).message}`);
    return;
  }
  console.log(`[harness] stopped harness on ${it.port}`);
}

/**
 * The version belongs to the package, and where that sits differs between the
 * two trees this runs in: `dist/server.js` has it one level up, `server/src/`
 * has `server/package.json` there — which is private and carries no version at
 * all. So take the first manifest above us that actually has one.
 */
function packageVersion(): string | null {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const { version } = JSON.parse(
        readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'),
      ) as { version?: unknown };
      if (typeof version === 'string') return version;
    } catch { /* not there, or not readable — try the next one up */ }
  }
  return null;
}

/**
 * Transport only. Herdr owns the session, the transcripts own the content, and
 * `Board` owns the join — nothing here holds state beyond the socket set.
 *
 * Built, this process serves the browser itself and /api and /ws are
 * same-origin off the one port. In development there is no build beside it, so
 * Vite serves the page and proxies both back here.
 */

/**
 * Still `logger: false`: the terminal stays quiet, and `log.ts` takes what is
 * worth keeping to a file instead. A pino transport would give the same lines
 * plus a dependency and a stdout nobody asked for.
 */
const app = Fastify({ logger: false });
const clients = new Set<WebSocket>();

/**
 * A route that threw rather than answering — a bug here, not a Herdr failure,
 * which is why it is separate from `act`. Fastify still sends its own 500; this
 * only makes sure the stack does not vanish with the response.
 */
app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
  logError(`${err.statusCode ?? 500} ${req.method} ${req.url}`, err);
  void reply.code(err.statusCode ?? 500).send({ error: err.message });
});

/** See `origin.ts` — this is the only thing standing in front of an unauthenticated API. */
app.addHook('onRequest', async (req, reply) => {
  if (!admits(req.headers.host, req.headers.origin)) {
    return reply.code(403).send({ error: 'only local, same-origin requests are accepted' });
  }
});

function broadcast(event: ServerEvent): void {
  const payload = JSON.stringify(event);
  for (const c of clients) {
    if (c.readyState === c.OPEN) c.send(payload);
  }
}

const history = new History();
/** What the human has delegated, per checkout. Keyed on a path, so it persists. */
const projects = new Projects();
let herdrError: string | undefined;

// `board` is captured, not called, at construction time — both callbacks fire
// only after herdr.start() below.
const herdr = new Herdr(
  () => board.schedule(),
  (connected, error) => {
    // The board dims and recovers on its own, so this transition leaves no
    // trace anyone can go back to — and "it went blank for a minute" is exactly
    // the report that needs one.
    log(connected ? 'herdr connected' : `herdr disconnected${error ? `: ${error}` : ''}`);
    herdrError = error;
    broadcast({
      type: 'herdr',
      connected,
      ...(error ? { error } : {}),
      ...(herdr.warning ? { warning: herdr.warning } : {}),
    });
    if (connected) board.schedule();
  },
);

/**
 * Side conversations, forked off an agent's session. Constructed before the
 * board because the board tells it when a session ends — by the pane closing or
 * by `/clear` — and a fork of a conversation that is gone has nothing to answer
 * out of.
 */
const asides = new Aside(herdr);

const board = new Board(
  herdr,
  history,
  projects,
  () => {
    broadcast({ type: 'agents', agents: board.agents(), workspaces: board.workspaceRows() });
    broadcast({ type: 'recent', recent: board.recent() });
  },
  (paneId) => void asides.close(paneId).catch(() => {}),
);

/**
 * The limits are read through an agent of our own, so no working agent has to
 * give up a turn to answer a question that was never about it.
 */
const usage = new Usage(herdr);

/** Subagent transcripts are read on demand only — they run to hundreds of KB. */
const subagentTranscripts = new Transcripts();

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

app.get<{ Params: { paneId: string }; Querystring: { turn?: string } }>(
  '/api/agents/:paneId/feed',
  async (req, reply) => {
    const row = board.row(req.params.paneId);
    if (!row) return reply.code(404).send({ error: 'no such agent' });

    const turns = feedTurns(board.entries(req.params.paneId), row.cwd);
    const index = req.query.turn !== undefined ? Number(req.query.turn) : turns.length - 1;
    const page: FeedPage = {
      turn: Number.isInteger(index) ? (turns[index] ?? null) : null,
      totalTurns: turns.length,
    };
    return page;
  },
);

app.get<{ Params: { paneId: string; agentId: string } }>(
  '/api/agents/:paneId/subagent/:agentId',
  async (req, reply) => {
    const row = board.row(req.params.paneId);
    if (!row?.transcriptPath) return reply.code(404).send({ error: 'no transcript' });

    const path = subagentPathFor(row.transcriptPath, req.params.agentId);
    if (!path) return reply.code(404).send({ error: 'subagent transcript is not on disk' });

    // `sidechain` is not optional here: every entry in a subagent transcript
    // carries `isSidechain: true`, so without it this returned an empty list
    // for every subagent that has ever run.
    const entries: FeedEntry[] = feedTurns(subagentTranscripts.entries(path), row.cwd, {
      sidechain: true,
    }).flatMap((t) => t.entries);
    return { entries };
  },
);

/**
 * Every subagent of one agent. Read from the subagents directory rather than
 * from the parent's tool results, so a subagent that is still running — the one
 * worth watching — is listed too.
 */
app.get<{ Params: { paneId: string } }>('/api/agents/:paneId/subagents', async (req, reply) => {
  const row = board.row(req.params.paneId);
  if (!row) return reply.code(404).send({ error: 'no such agent' });
  if (!row.transcriptPath) return { subagents: [] } satisfies SubagentsView;

  const view: SubagentsView = {
    subagents: subagentRows(
      board.entries(req.params.paneId),
      row.transcriptPath,
      row.cwd,
      row.status,
      subagentTranscripts,
    ),
  };
  return view;
});

/**
 * This agent's aside, if it has one. The parent's own entries go in because the
 * aside's exchange is defined against them — the fork's transcript holds the
 * parent's whole conversation, and only the parent can say which part of it is
 * inherited.
 */
app.get<{ Params: { paneId: string } }>('/api/agents/:paneId/aside', async (req, reply) => {
  const row = board.row(req.params.paneId);
  if (!row) return reply.code(404).send({ error: 'no such agent' });

  try {
    const view: AsideView = await asides.view(row, board.entries(req.params.paneId));
    return view;
  } catch (err) {
    return reply.code(503).send({ error: (err as Error).message });
  }
});

app.get<{ Params: { paneId: string } }>('/api/agents/:paneId/diff', async (req, reply) => {
  const row = board.row(req.params.paneId);
  if (!row) return reply.code(404).send({ error: 'no such agent' });

  const diff = buildAgentDiff(board.entries(req.params.paneId), row.cwd);
  const contention = board.contention(req.params.paneId);
  const annotated: AgentDiff = {
    files: diff.files.map((f) => {
      const others = contention.get(f.path);
      return others ? { ...f, contendedWith: others } : f;
    }),
  };
  return annotated;
});

/**
 * One file from that changelist, as it is on disk now — what the diff view's
 * copy button hands you. The path must be one THIS agent wrote: the check is
 * not decoration, it is the only thing standing between a browser with no auth
 * and every file on the machine.
 */
app.get<{ Params: { paneId: string }; Querystring: { path?: string } }>(
  '/api/agents/:paneId/file',
  async (req, reply) => {
    if (!board.row(req.params.paneId)) return reply.code(404).send({ error: 'no such agent' });

    const path = req.query.path ?? '';
    if (!touchedPaths(board.entries(req.params.paneId)).includes(path)) {
      return reply.code(404).send({ error: 'this agent did not write that file' });
    }

    try {
      return { path, content: readTouchedFile(path) } satisfies FileContent;
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  },
);

/**
 * The one place raw terminal text reaches the browser. We do not parse
 * permission prompts, so a blocked agent shows its pane verbatim.
 */
app.get<{ Params: { paneId: string } }>('/api/agents/:paneId/blocked', async (req, reply) => {
  try {
    const view: BlockedView = { paneId: req.params.paneId, text: await herdr.read(req.params.paneId, 80) };
    return view;
  } catch (err) {
    return reply.code(503).send({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function act(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return { ok: true };
  } catch (err) {
    // Every action route funnels through here, so this is the one place that
    // sees a Herdr request fail. The browser shows the message and the human
    // moves on; the log is what still has it an hour later.
    logError('action failed', err);
    return reply.code(503).send({ error: (err as Error).message });
  }
}

app.post<{ Params: { paneId: string }; Body: { text?: string } }>(
  '/api/agents/:paneId/prompt',
  async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    return act(reply, () => herdr.prompt(req.params.paneId, text));
  },
);

/**
 * Asks the aside, forking one off this agent's session if there is none yet.
 * The first question is slow — a tab, a launch, and Claude Code loading a forked
 * transcript — so the browser says so rather than looking hung.
 */
app.post<{ Params: { paneId: string }; Body: { text?: string } }>(
  '/api/agents/:paneId/aside',
  async (req, reply) => {
    const row = board.row(req.params.paneId);
    if (!row) return reply.code(404).send({ error: 'no such agent' });
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });

    return act(reply, () => asides.send(row, board.entries(req.params.paneId), text));
  },
);

/**
 * Ends the aside. Also how you refork one: with no aside left, the next question
 * takes a fresh copy of wherever the parent has got to since.
 */
app.post<{ Params: { paneId: string } }>('/api/agents/:paneId/aside/close', async (req, reply) =>
  act(reply, () => asides.close(req.params.paneId)),
);

/**
 * Unblocking is optimistic by design: we send the keystroke without knowing
 * what the prompt is, then the client re-reads the pane to show what happened.
 */
app.post<{ Params: { paneId: string }; Body: { keys?: string[] } }>(
  '/api/agents/:paneId/keys',
  async (req, reply) => {
    const keys = req.body?.keys;
    if (!Array.isArray(keys) || keys.length === 0) {
      return reply.code(400).send({ error: 'keys is required' });
    }
    return act(reply, () => herdr.sendKeys(req.params.paneId, keys));
  },
);

/**
 * Answers a prompt that wants words rather than a number — the "tell Claude
 * what to do differently" branch of a permission dialog. Same optimism as the
 * key buttons: we do not parse the prompt, we type and let the human re-read.
 */
app.post<{ Params: { paneId: string }; Body: { text?: string } }>(
  '/api/agents/:paneId/text',
  async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'text is required' });
    return act(reply, () => herdr.sendText(req.params.paneId, text));
  },
);

/**
 * "Is what I am looking at actually current?" — the answer to being starved of
 * the event stream by a newer subscriber, which is invisible from our side and
 * never heals on its own. Reclaims the stream AND resyncs, because either one
 * alone leaves half the problem.
 */
app.post('/api/refresh', async () => {
  herdr.reconnect();
  board.schedule();
  return { ok: true };
});

/**
 * Ends the cockpit, not the agents — they are Herdr's, and they keep running.
 *
 * Deferred rather than awaited: `shutdown` ends in `app.close()`, which waits
 * for in-flight requests, so awaiting it inside a handler would be this request
 * waiting on itself. `setImmediate` and not `process.nextTick` — the nextTick
 * queue drains BEFORE promise microtasks, so it would start the shutdown before
 * Fastify had serialised this reply.
 *
 * The broadcast is what every viewer needs: the reply reaches the one tab that
 * asked, and a working session has had sixteen open.
 */
app.post('/api/quit', async () => {
  broadcast({ type: 'quit' });
  setImmediate(shutdown);
  return { ok: true };
});

/**
 * The account's limits. No pane in the path: `usage.ts` keeps an agent of its
 * own for this, so reading them costs no working agent a turn.
 */
app.post('/api/usage', async (_req, reply) => {
  try {
    const view: UsageView = await usage.read();
    return view;
  } catch (err) {
    return reply.code(503).send({ error: (err as Error).message });
  }
});

app.post<{ Params: { paneId: string } }>('/api/agents/:paneId/interrupt', async (req, reply) =>
  act(reply, () => herdr.sendKeys(req.params.paneId, ['escape'])),
);

app.post<{ Params: { paneId: string } }>('/api/agents/:paneId/focus', async (req, reply) =>
  act(reply, () => herdr.focus(req.params.paneId)),
);

/**
 * RECENT is ours, not Herdr's, so forgetting is a local edit — no socket call.
 * Both routes broadcast so every open tab drops the row at once.
 */
app.post<{ Params: { paneId: string } }>('/api/recent/:paneId/remove', async (req) => {
  history.forget(req.params.paneId);
  broadcast({ type: 'recent', recent: board.recent() });
  return { ok: true };
});

app.post('/api/recent/clear', async () => {
  history.clear();
  broadcast({ type: 'recent', recent: board.recent() });
  return { ok: true };
});

/** Herdr's own constraint on agent names; a rejected slug fails the whole start. */
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

app.post<{ Params: { paneId: string }; Body: { name?: string } }>(
  '/api/agents/:paneId/rename',
  async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name || !NAME_RE.test(name)) {
      return reply.code(400).send({ error: 'name must match [a-z][a-z0-9_-]{0,31}' });
    }
    return act(reply, async () => {
      await herdr.rename(req.params.paneId, name);
      board.schedule();
    });
  },
);

/**
 * Starting an agent is one click: no name, no directory, no placement. The
 * directory belongs to the space, and `agent.start` takes none of its own — it
 * comes from the pane, so the tab is created in the space's dir first.
 */
app.post<{ Params: { id: string } }>('/api/workspaces/:id/agents', async (req, reply) => {
  const space = board.workspace(req.params.id);
  if (!space) return reply.code(404).send({ error: 'no such space' });
  if (!space.dir) return reply.code(400).send({ error: 'set a directory for this space first' });

  const name = board.nextAgentName(space.label);
  try {
    // ~4s of waiting inside there, and the button says so. A start that fails
    // leaves no tab behind — see `launchAgent`.
    const paneId = await herdr.launchAgent(
      name,
      { workspaceId: space.id, cwd: space.dir, label: name },
      startArgs(projects.gitDelegated(space.dir)),
    );
    board.schedule();
    return { ok: true, paneId, name };
  } catch (err) {
    return reply.code(503).send({ error: (err as Error).message });
  }
});

app.post<{ Body: { label?: string } }>('/api/workspaces', async (req, reply) =>
  act(reply, async () => {
    await herdr.request('workspace.create', req.body?.label ? { label: req.body.label } : {});
    board.schedule();
  }),
);

app.post<{ Params: { id: string }; Body: { label?: string } }>(
  '/api/workspaces/:id/rename',
  async (req, reply) => {
    const label = req.body?.label?.trim();
    if (!label) return reply.code(400).send({ error: 'label is required' });
    return act(reply, async () => {
      await herdr.request('workspace.rename', { workspace_id: req.params.id, label });
      board.schedule();
    });
  },
);

/**
 * The dir is ours, not Herdr's, so it is checked here — a path that does not
 * exist would otherwise fail much later, inside `tab.create`.
 *
 * The git grant rides along rather than taking a route of its own: it is a
 * second fact about the same resolved path, and this is the only place that
 * already turns what the human typed into one.
 */
app.post<{ Params: { id: string }; Body: { dir?: string; gitDelegated?: boolean } }>(
  '/api/workspaces/:id/dir',
  async (req, reply) => {
    const dir = req.body?.dir?.trim();
    if (!dir) return reply.code(400).send({ error: 'dir is required' });
    if (!board.workspace(req.params.id)) return reply.code(404).send({ error: 'no such space' });

    const resolved = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
    if (!statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
      return reply.code(400).send({ error: `not a directory: ${resolved}` });
    }
    if (typeof req.body?.gitDelegated === 'boolean') {
      projects.setGitDelegated(resolved, req.body.gitDelegated);
      // Not just this space: the grant is on the checkout, so every space
      // pointed at it has just changed. A resync is the only thing that reaches
      // all of them.
      board.schedule();
    }
    board.setSpaceDir(req.params.id, resolved);
    return { ok: true, dir: resolved, gitDelegated: projects.gitDelegated(resolved) };
  },
);

/**
 * An agent's slot and its shade are both ours alone, so like `/dir` above
 * neither goes near Herdr: no `act`, no `board.schedule()` — the setter's own
 * broadcast is the entire effect.
 *
 * `index` is a position within the agent's own space, and `null` releases it.
 * The board clamps it against the space as it stands, so a slot that has become
 * unreachable is not an error here.
 */
app.post<{ Params: { paneId: string }; Body: { index?: unknown } }>(
  '/api/agents/:paneId/lock',
  async (req, reply) => {
    const index = req.body?.index ?? null;
    if (index !== null && (!Number.isInteger(index) || (index as number) < 0)) {
      return reply.code(400).send({ error: 'index must be a non-negative integer or null' });
    }
    if (!board.row(req.params.paneId)?.live) {
      return reply.code(404).send({ error: 'no such agent' });
    }
    board.lock(req.params.paneId, index as number | null);
    return { ok: true, index };
  },
);

/** Releases every locked agent in one space — the header's ⇅. */
app.post<{ Params: { id: string } }>('/api/workspaces/:id/unlock', async (req, reply) => {
  if (!board.workspace(req.params.id)) return reply.code(404).send({ error: 'no such space' });
  board.unlockSpace(req.params.id);
  return { ok: true };
});

app.post<{ Params: { paneId: string }; Body: { shade?: unknown } }>(
  '/api/agents/:paneId/shade',
  async (req, reply) => {
    // Checked against the runtime list, not the union: a TS type proves nothing
    // about what arrived on the wire.
    const shade = req.body?.shade ?? null;
    if (shade !== null && !(AGENT_SHADES as readonly unknown[]).includes(shade)) {
      return reply.code(400).send({ error: `shade must be null or one of ${AGENT_SHADES.join(', ')}` });
    }
    // A closed agent is a 404 here, not merely a no-op: `row()` answers out of
    // RECENT too, and a shade remembered against a dead pane would come back on
    // whatever agent inherits its id.
    if (!board.row(req.params.paneId)?.live) {
      return reply.code(404).send({ error: 'no such agent' });
    }
    board.setShade(req.params.paneId, shade as AgentShade | null);
    return { ok: true, shade };
  },
);

app.post<{ Params: { id: string } }>('/api/workspaces/:id/close', async (req, reply) =>
  act(reply, async () => {
    await herdr.request('workspace.close', { workspace_id: req.params.id });
    board.schedule();
  }),
);

app.post<{ Params: { id: string } }>('/api/tabs/:id/close', async (req, reply) =>
  act(reply, async () => {
    await herdr.request('tab.close', { tab_id: req.params.id });
    board.schedule();
  }),
);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Facts about this install, read straight off the disk each time. Nothing here
 * is cached or broadcast: none of it changes unless somebody changes it on this
 * screen, and it is read far too rarely to be worth keeping in step.
 */
const settingsView = (): SettingsView => ({
  rules: { text: rulesText(), isDefault: rulesAreDefault() },
  checkouts: projects.all(),
  claudeFiles: claudeFiles(),
  herdr: herdrRuleState(),
});

app.get('/api/settings', async () => settingsView());

/** Blank, or the shipped text, removes the override — see `setRules`. */
app.post<{ Body: { text?: string } }>('/api/settings/rules', async (req, reply) => {
  if (typeof req.body?.text !== 'string') return reply.code(400).send({ error: 'text is required' });
  try {
    setRules(req.body.text);
  } catch (err) {
    // Unlike the caches, this one reports: a rules edit the human believes was
    // saved and was not is the worst possible failure of this screen.
    return reply.code(500).send({ error: `could not save rules: ${(err as Error).message}` });
  }
  return settingsView();
});

/**
 * The same store the space editor writes, reached by path instead of by space —
 * this screen is the only place a checkout with no space pointed at it can be
 * revoked.
 */
app.post<{ Body: { path?: string; gitDelegated?: boolean } }>(
  '/api/settings/checkouts',
  async (req, reply) => {
    const { path, gitDelegated } = req.body ?? {};
    if (typeof path !== 'string' || typeof gitDelegated !== 'boolean') {
      return reply.code(400).send({ error: 'path and gitDelegated are required' });
    }
    projects.setGitDelegated(path, gitDelegated);
    board.schedule();
    return settingsView();
  },
);

app.post<{ Body: { force?: boolean } }>('/api/settings/claude-files', async (req) => {
  installClaudeFiles(req.body?.force === true);
  return settingsView();
});

/**
 * The only settings write whose answer is not fully visible in the view it
 * returns: `upstream`, `no-remote` and `unavailable` all leave the state exactly
 * as it was, so without the outcome the button reads as broken rather than as
 * having correctly declined to do anything.
 */
app.post<{ Body: { force?: boolean } }>('/api/settings/herdr', async (req) => {
  const { outcome, state } = installHerdrRule(req.body?.force === true);
  return { ...settingsView(), note: herdrRuleNote(outcome, state) };
});

// ---------------------------------------------------------------------------
// The page itself
// ---------------------------------------------------------------------------

/**
 * How a starting harness tells whether the thing already holding a port is
 * another harness or an unrelated server. Deliberately says nothing about the
 * agents: it is answered before any caller has been identified, and on a port
 * any page in the browser can reach.
 */
app.get(HEALTH_PATH, async () => ({
  harness: true,
  pid: process.pid,
  // The two facts a second invocation needs to decide whether to open a browser,
  // and the reason it stopped opening one onto a JSON 404: whether this process
  // serves the page at all, and whether anyone is already looking at it.
  page: built,
  viewers: clients.size,
} satisfies Health));

/**
 * The built page, beside this file in `dist/`. Its absence is the ordinary
 * development case rather than an error — Vite is serving the page then, and
 * this process is only the API it proxies to.
 *
 * `@fastify/static` rather than a hand-rolled file route: it resolves paths
 * against the root instead of trusting the URL, and traversal out of a served
 * directory is precisely the bug this codebase cannot afford, on a server with
 * no auth whose other routes type into live terminals.
 */
const webRoot = fileURLToPath(new URL('./web/', import.meta.url));
const built = existsSync(join(webRoot, 'index.html'));
if (built) {
  await app.register(fastifyStatic, { root: webRoot });
} else {
  /**
   * What a browser lands on when it reaches the API port in development, where
   * there is no page here to serve. Fastify's own answer —
   * `{"message":"Route GET:/ not found"}` — is accurate and tells the person
   * reading it nothing, and tabs onto it accumulated faster than anyone would
   * close them. They are the reason this exists: a stale one now explains
   * itself on reload instead of being another thing to identify.
   *
   * Only `/`. Every other unmatched path keeps the JSON 404, which is the right
   * answer for the API this actually is.
   */
  app.get('/', async (_req, reply) =>
    reply.type('text/html').send(
      `<!doctype html><meta charset="utf-8"><title>harness — api</title>`
      + `<body style="font:14px/1.6 ui-monospace,monospace;margin:3rem auto;max-width:32rem;padding:0 1rem">`
      + `<p>This port is the harness <b>API</b>. It serves no page: nothing has been built here,`
      + ` so the cockpit is the one Vite serves.</p>`
      + `<p><a href="${urlFor(DEV_PAGE_PORT)}">${urlFor(DEV_PAGE_PORT)}</a> — up whenever <code>npm run dev</code> is.</p>`
      + `<p>Building (<code>npm run build</code>) puts the page on this port instead.</p>`,
    ));
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  clients.add(ws);
  const hello: ServerEvent = {
    type: 'hello',
    workspaces: board.workspaceRows(),
    agents: board.agents(),
    recent: board.recent(),
    herdrConnected: herdr.connected,
  };
  ws.send(JSON.stringify(hello));
  // `hello` carries only whether Herdr is up; anything to SAY about it — down,
  // or up and speaking an unverified protocol — follows as its own event, so a
  // tab opened later hears it too.
  if (!herdr.connected || herdr.warning) {
    ws.send(JSON.stringify({
      type: 'herdr',
      connected: herdr.connected,
      ...(herdrError ? { error: herdrError } : {}),
      ...(herdr.warning ? { warning: herdr.warning } : {}),
    } satisfies ServerEvent));
  }
  ws.on('close', () => clients.delete(ws));
});

await app.ready();
app.server.on('upgrade', (req, socket, head) => {
  // The `onRequest` hook never runs for an upgrade — it is not a route — so the
  // check is repeated here rather than assumed. This is the socket that leaked
  // the board to any open tab.
  if (req.url !== WS_PATH || !admits(req.headers.host, req.headers.origin)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const port = values.port !== undefined ? Number(values.port) : Number(process.env.PORT ?? DEFAULT_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`[harness] not a port: ${values.port ?? process.env.PORT}`);
  process.exit(1);
}

/**
 * The mutex, and it runs before the bind rather than being it — a `--port` that
 * can move makes binding lock nothing, and two live cockpits mean the newer one
 * silently starves the older of Herdr's event stream forever (invariant 2).
 *
 * A second invocation is treated as "show me the harness", not as an error:
 * that is what someone typing the command twice actually wants.
 */
const existing = await running();
if (existing) {
  console.log(`[harness] already running at ${urlFor(existing.port)} (pid ${existing.pid})`);
  // Which tab to open is the whole question here, and the old answer — this
  // port, always — was wrong twice over. A dev instance serves no page, so that
  // tab was a JSON 404, one more of them per invocation until the browser was
  // full of them. And a cockpit that is already on screen does not need a
  // second copy: `open` gives you a new tab rather than the one you have.
  //
  // `shouldOpen` is the whole decision and it is deliberately conservative —
  // read it before touching this, because the failure it prevents is the tabs
  // piling up, and every previous attempt at it also looked correct.
  if (!shouldOpen(existing) || values['no-open']) {
    const tabs = existing.viewers === 1 ? 'a browser tab' : `${existing.viewers} browser tabs`;
    console.log(existing.viewers > 0
      ? `[harness] already open in ${tabs}`
      : `[harness] open ${(await pageOf(existing)) ?? urlFor(existing.port)} to see it`);
  } else {
    openBrowser(urlFor(existing.port));
  }
  process.exit(0);
}

try {
  await app.listen({ host: BIND_HOST, port });
} catch (err) {
  if ((err as { code?: string }).code === 'EADDRINUSE') {
    // Not another harness: the probe above already established that. Saying so
    // is the point — the old message blamed an instance that was not there and
    // sent people hunting for it.
    console.error(`[harness] port ${port} is held by something else, and it is not a harness.`);
    console.error(`[harness] try: harness --port ${port + 1}`);
    process.exit(1);
  }
  throw err;
}

if (!claim(port)) {
  console.warn('[harness] could not write ~/.harness/harness.lock — a second instance will go undetected');
  log('could not write the lockfile — a second instance will go undetected');
}

// Opened after the bind, so the file describes a cockpit that is actually up
// and a failed start leaves the previous run's log intact to explain itself.
logStart({
  harness: packageVersion() ?? 'unknown',
  node: process.versions.node,
  platform: process.platform,
  port,
  built,
});

// Before the stream, so the guidance is the first thing on screen rather than
// buried under a retry loop. Never fatal: see `Herdr.preflight`.
for (const note of await herdr.preflight()) {
  console.warn(`[harness] ${note}`);
  // Preflight is the one diagnostic that scrolls away: it prints once at start
  // and a cockpit left open for days has long since lost it.
  log(`preflight: ${note}`);
}
log(`herdr server ${herdr.serverVersion ?? 'unknown'}`);

herdr.start();
// Independent of the stream on purpose: the board must keep telling the truth
// even when Herdr has handed our pushes to a newer subscriber.
board.start();

const url = urlFor(port);
if (built) {
  console.log(`[harness] ${url}`);
  if (!values['no-open']) openBrowser(url);
} else {
  console.log(`[harness] api on ${url} — no build here, so run Vite for the page`);
}

/**
 * Long enough for one `pane.close` over a unix socket, which is milliseconds,
 * and short enough that ctrl-C never feels like a hang. Herdr going quiet
 * mid-request must cost the tidy-up, never the exit.
 */
const CLEANUP_MS = 2_000;

let shuttingDown = false;

/**
 * The one way out, whether it came from ctrl-C, `harness stop` (which sends
 * SIGTERM) or the ⏻ in the page. Agents are Herdr's and keep running; what ends
 * here is the cockpit watching them.
 *
 * The usage agent is the one pane here that is purely ours — no conversation,
 * no work, nothing a human would go back to — so it closes with the cockpit
 * rather than outliving it. Asides deliberately do not: each holds an exchange
 * the human opened, and one is found again by name when the harness comes back.
 */
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  release();
  void Promise.race([
    usage.close().catch(() => {}),
    new Promise((r) => setTimeout(r, CLEANUP_MS)),
  ]).then(() => {
    herdr.stop();
    void app.close().then(() => process.exit(0));
  });
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
