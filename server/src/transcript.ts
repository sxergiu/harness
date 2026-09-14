import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import type { AgentStatus, ContextUse, FeedEntry, FeedTurn, SubagentRow } from '@harness/shared';
import { sqlOf } from './sql.js';

/**
 * Claude Code's own transcripts are the content half of the board. Herdr tells
 * us an agent exists and what its session id is; everything the agent actually
 * said or did is read from here.
 *
 * Nothing in this file may assume the transcript exists. It is pruned on a
 * retention timer, so "missing" is a normal state, not an error.
 */

export interface Entry {
  type?: string;
  /**
   * Stable across a `--fork-session`: the fork rewrites the parent's history
   * under a new session id but keeps every entry's uuid, which is what lets an
   * aside tell its own exchange from the conversation it inherited. Absent on
   * the bookkeeping types — `ai-title`, `mode`, `permission-mode`,
   * `last-prompt`, `file-history-snapshot` — which the fork writes fresh copies
   * of, so any comparison must skip the entries that have none.
   */
  uuid?: string;
  message?: { role?: string; content?: unknown; usage?: Usage };
  toolUseResult?: unknown;
  attachment?: unknown;
  timestamp?: string;
  isSidechain?: boolean;
  /** Set by Claude Code on its own generated `user` entries, not the human's. */
  isMeta?: boolean;
  /**
   * Set on an `assistant` entry Claude Code wrote in place of a response
   * because the request failed. The text is the whole error.
   */
  isApiErrorMessage?: boolean;
  /** On a SUBAGENT's assistant entries: which agent type produced it. */
  attributionAgent?: unknown;
  /** `system` entries carry their text here rather than under `message`. */
  content?: unknown;
  /** `local_command` marks a slash command recorded as a `system` entry. */
  subtype?: string;
}

/**
 * What one request cost. Recorded on every real `assistant` entry; an entry
 * Claude Code wrote in place of a failed response carries a synthetic all-zero
 * one, which is why every reader here ignores zeros rather than trusting them.
 */
interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** An active `/goal`: Claude keeps working until the condition is judged met. */
export interface Goal {
  condition: string;
  met: boolean;
}

/** The newest `/feature` or `/investigate`: one slot, and the later one wins. */
export interface Assignment {
  kind: 'feature' | 'investigate';
  text: string;
  /**
   * Where in the transcript it was set. Only the board uses it, to count what
   * has been written SINCE — the session-wide count would charge an
   * investigation with the writes of the feature it replaced.
   */
  at: number;
}

/** `/Users/x/repos/web.app` → `-Users-x-repos-web-app`. Dots become dashes too. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

export function transcriptPathFor(cwd: string, sessionUuid: string): string | null {
  const path = join(homedir(), '.claude', 'projects', slugForCwd(cwd), `${sessionUuid}.jsonl`);
  return existsSync(path) ? path : null;
}

/** Subagent transcripts live beside the parent, under a directory named for it. */
export function subagentDirFor(transcriptPath: string): string {
  return join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
}

export function subagentPathFor(transcriptPath: string, agentId: string): string | null {
  const path = join(subagentDirFor(transcriptPath), `agent-${agentId}.jsonl`);
  return existsSync(path) ? path : null;
}

// ---------------------------------------------------------------------------
// Incremental reading
// ---------------------------------------------------------------------------

interface Cached {
  /** Byte offset just past the last complete line we consumed. */
  offset: number;
  entries: Entry[];
}

/**
 * Parses each transcript once and then only its appended tail. Board refreshes
 * touch every live agent, and re-parsing a megabyte per event would not hold up.
 */
export class Transcripts {
  private cache = new Map<string, Cached>();

  entries(path: string): Entry[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      this.cache.delete(path);
      return [];
    }

    let c = this.cache.get(path);
    // A shrunken file is a different file: /clear, or a prune-and-rewrite.
    if (!c || size < c.offset) {
      c = { offset: 0, entries: [] };
      this.cache.set(path, c);
    }
    if (size === c.offset) return c.entries;

    const buf = Buffer.allocUnsafe(size - c.offset);
    let fd: number | null = null;
    try {
      fd = openSync(path, 'r');
      readSync(fd, buf, 0, buf.length, c.offset);
    } catch {
      return c.entries;
    } finally {
      if (fd !== null) closeSync(fd);
    }

    // Stop at the last newline: the tail may be a half-written line, and
    // cutting mid-character would corrupt the UTF-8 decode of the next read.
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) return c.entries;

    for (const line of buf.subarray(0, end + 1).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        c.entries.push(JSON.parse(line) as Entry);
      } catch { /* a torn line; the next read will not include it */ }
    }
    c.offset += end + 1;
    return c.entries;
  }

  forget(path: string): void {
    this.cache.delete(path);
  }
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function blocks(e: Entry): Block[] {
  const c = e.message?.content;
  return Array.isArray(c) ? (c as Block[]) : [];
}

/** User content is sometimes a bare string rather than an array of blocks. */
function userText(e: Entry): string | null {
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const text = (c as Block[]).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
  return text.trim() ? text : null;
}

// ---------------------------------------------------------------------------
// Board fields
// ---------------------------------------------------------------------------

/** The two context windows Claude Code runs with. `[1m]` in a model id picks the second. */
const WINDOW = 200_000;
const WINDOW_1M = 1_000_000;

/**
 * Context held by the agent's newest request, and the window it is held against.
 *
 * The tokens are exact and need no interpretation: input + cache_read +
 * cache_creation IS what the model was sent, and a compaction shows up for free
 * as the next request measuring less.
 *
 * The WINDOW is the soft part. Nothing records it — a transcript says
 * `claude-opus-5` whether the session runs 200k or 1M — so it is read from the
 * model in the user's own settings, the same file these agents load, and
 * widened if any request in this session ever exceeded it. A session that
 * outgrew the assumed window is proof of a larger one.
 */
export function contextOf(entries: Entry[]): ContextUse | null {
  let last = 0;
  let peak = 0;
  for (const e of entries) {
    // A subagent's requests are its own context, not the parent's.
    if (e.isSidechain || e.type !== 'assistant') continue;
    const u = e.message?.usage;
    if (!u) continue;
    const tokens =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (tokens <= 0) continue; // the synthetic usage of a failed request
    last = tokens;
    peak = Math.max(peak, tokens);
  }
  if (last === 0) return null;
  const base = configuredWindow();
  return { tokens: last, window: peak > base ? WINDOW_1M : base };
}

/** mtime of the settings we last parsed, so this is one stat per resync. */
let settingsAt = -1;
let settingsWindow = WINDOW;

function configuredWindow(): number {
  const path = join(homedir(), '.claude', 'settings.json');
  try {
    const { mtimeMs } = statSync(path);
    if (mtimeMs !== settingsAt) {
      settingsAt = mtimeMs;
      const model = (JSON.parse(readFileSync(path, 'utf8')) as { model?: unknown }).model;
      settingsWindow = typeof model === 'string' && model.includes('[1m]') ? WINDOW_1M : WINDOW;
    }
  } catch {
    // No settings file, or one we cannot parse. The smaller window is the safe
    // read: it over-reports rather than hiding that a session is nearly full.
  }
  return settingsWindow;
}

/** The newest tool call, as a line you can read at a glance. */
export function activityOf(entries: Entry[], cwd: string): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'assistant') continue;
    for (const b of [...blocks(e)].reverse()) {
      if (b.type !== 'tool_use' || !b.name) continue;
      return `${b.name.toLowerCase()} ${summarise(b.name, b.input ?? {}, cwd)}`.trim();
    }
  }
  return null;
}

/** The in_progress item of the most recent TodoWrite, when the agent keeps one. */
export function todoOf(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'assistant') continue;
    for (const b of [...blocks(e)].reverse()) {
      if (b.type !== 'tool_use' || b.name !== 'TodoWrite') continue;
      const todos = b.input?.todos;
      if (!Array.isArray(todos)) return null;
      for (const t of todos as Array<Record<string, unknown>>) {
        if (t.status === 'in_progress') {
          const label = t.activeForm ?? t.content;
          return typeof label === 'string' ? label : null;
        }
      }
      return null;
    }
  }
  return null;
}

/**
 * The API error this agent is stuck on right now, or null.
 *
 * Claude Code records a failed request as an `assistant` entry flagged
 * `isApiErrorMessage`, whose whole text is the message — observed forms include
 * "API Error: Unable to connect to API (ENOTFOUND)", "API Error: Connection
 * closed mid-response", "You've hit your session limit · resets 9:40pm" and
 * "Login expired · Please run /login".
 *
 * Most of those are transient and Claude Code simply retries, so an error is
 * only worth reporting while it is still the LAST substantive entry: any
 * assistant output or human message after it means the agent recovered.
 * Everything Claude Code writes in between — `system` entries, file-history
 * snapshots, last-prompt records — is plumbing and does not clear it.
 *
 * Unlike `goalOf`, this reads no unstable nested shape: a boolean flag and the
 * entry's own text, both of which are already handled elsewhere in this file.
 */
export function errorOf(entries: Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    if (e.type === 'assistant') {
      return e.isApiErrorMessage ? entryText(e).trim() || 'API error' : null;
    }
    // A real message from the human means they have already seen and moved past
    // it. Claude Code's own generated `user` entries have not.
    if (e.type === 'user' && !e.isMeta) return null;
  }
  return null;
}

/** Aliases `/goal` accepts for removing the goal. */
const GOAL_CLEAR = /^(clear|stop|off|reset|none|cancel)$/i;

const STDOUT_RE = /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/;

/**
 * An entry's text, wherever it lives. `user` entries keep it under
 * `message.content`; `system` entries — how /usage and other local commands are
 * recorded — put it at the top level instead. Reading only one of the two makes
 * whole commands disappear from the feed.
 */
function entryText(e: Entry): string {
  if (typeof e.content === 'string') return e.content;
  const c = e.message?.content;
  if (typeof c === 'string') return c;
  return blocks(e).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
}

/** Unwraps `<local-command-stdout>…</local-command-stdout>` when present. */
function stripStdout(text: string): string {
  return (STDOUT_RE.exec(text.trim())?.[1] ?? text).trim();
}

/**
 * The active goal, or null. Read from the `goal_status` attachment Claude Code
 * writes after each evaluation:
 *
 *   {"type":"attachment","attachment":{"type":"goal_status","met":false,
 *     "condition":"…"}}
 *
 * That shape is INTERNAL to Claude Code and documented as unstable across
 * releases, so every field is checked before use and anything unexpected reads
 * as "no goal" rather than throwing. `/clear` starts a new transcript, which
 * drops the goal for free; `/goal clear` is caught by the command scan below.
 */
export function goalOf(entries: Entry[]): Goal | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e) continue;

    const a = e.attachment;
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      const rec = a as Record<string, unknown>;
      if (rec.type === 'goal_status' && typeof rec.condition === 'string') {
        return { condition: rec.condition, met: rec.met === true };
      }
    }

    // A goal removed mid-session leaves the last goal_status behind it, so the
    // command itself has to win when it is more recent.
    if (e.type === 'user') {
      const cmd = commandOf(e);
      if (cmd?.name === '/clear') return null;
      if (cmd?.name === '/goal' && GOAL_CLEAR.test(cmd.args.trim())) return null;
    }
  }
  return null;
}

/**
 * What the agent was last set going on — the argument of the newest `/feature`
 * or `/investigate`, and which of the two it was.
 *
 * One slot for both, because they are alternatives: an `/investigate` says the
 * session is now for reading and talking, which a standing `/feature` would
 * contradict, and vice versa. So the later command wins outright.
 *
 * Unlike a goal there is nothing to read for completion: both end in prose and
 * leave no machine-readable trace, so this stands until the other replaces it
 * or `/clear` starts a session without one. It says what the session was set
 * to do, NOT that the doing is still going on — the todo line below it is what
 * moves. An argument-less command reads as no assignment rather than as an
 * empty one.
 */
export function assignmentOf(entries: Entry[]): Assignment | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== 'user') continue;
    const cmd = commandOf(e);
    if (cmd?.name === '/clear') return null;
    if (cmd?.name === '/feature' || cmd?.name === '/investigate') {
      const text = cmd.args.trim();
      return text ? { kind: cmd.name === '/feature' ? 'feature' : 'investigate', text, at: i } : null;
    }
  }
  return null;
}

/**
 * Slash commands arrive as user entries wrapping XML-ish tags rather than as
 * plain prose. Rendering that raw would show `<command-name>` to the human.
 */
export function commandOf(e: Entry): { name: string; args: string } | null {
  const text = entryText(e);
  if (!text.includes('<command-name>')) return null;

  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
  return { name: name.startsWith('/') ? name : `/${name}`, args };
}

/** The primary argument of a tool call, shortened for a one-line row. */
function summarise(name: string, input: Record<string, unknown>, cwd: string): string {
  const pick = (k: string): string | null => (typeof input[k] === 'string' ? (input[k] as string) : null);

  const path = pick('file_path') ?? pick('notebook_path');
  if (path) return relative(cwd, path).split(sep).join('/') || basename(path);

  const direct =
    pick('command') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('description');
  if (direct) return clip(direct, 80);

  if (name === 'TodoWrite') return 'todos';
  const first = Object.values(input).find((v) => typeof v === 'string');
  return typeof first === 'string' ? clip(first, 80) : '';
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = (content as Block[])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');
    return text.trim() ? text : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/**
 * Split into turns and project to renderable entries. A turn runs from one real
 * user message to the next — tool results are not turn boundaries even though
 * they arrive as `user` entries.
 */
export function feedTurns(
  entries: Entry[],
  cwd: string,
  /**
   * Whether these entries came from a SUBAGENT's own transcript. Every entry in
   * one is `isSidechain: true`, and no parent transcript contains a single
   * sidechain entry — so skipping them unconditionally, as this did, made every
   * subagent read as empty (136 entries in, 0 turns out). The flag is kept
   * rather than deleted because the skip is what stops subagent content leaking
   * into a parent's feed if Claude Code ever inlines it again.
   */
  opts: { sidechain?: boolean } = {},
): FeedTurn[] {
  // Results are resolved up front so a tool row can render its own outcome.
  const results = new Map<string, { text: string | null; ok: boolean }>();
  for (const e of entries) {
    if (e.type !== 'user') continue;
    for (const b of blocks(e)) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        results.set(b.tool_use_id, { text: resultText(b.content), ok: !b.is_error });
      }
    }
  }

  const agentMeta = subagentMeta(entries);
  const turns: FeedTurn[] = [];
  let current: FeedTurn | null = null;
  const open = (startedAt: string | null): FeedTurn => {
    const t: FeedTurn = { index: turns.length, startedAt, entries: [] };
    turns.push(t);
    current = t;
    return t;
  };

  for (const e of entries) {
    if (e.isSidechain && !opts.sidechain) continue;

    // Some slash commands (/usage among them) are recorded as `system` with
    // subtype `local_command` rather than as `user`. They are not conversational
    // turns, so they attach to the turn in progress instead of starting one.
    if (e.type === 'system') {
      if (e.subtype !== 'local_command') continue;
      const turn = current ?? open(e.timestamp ?? null);
      const cmd = commandOf(e);
      if (cmd) {
        turn.entries.push({ kind: 'command', name: cmd.name, args: cmd.args });
      } else {
        const body = stripStdout(entryText(e));
        if (body) turn.entries.push({ kind: 'system', text: body });
      }
      continue;
    }

    if (e.type === 'user') {
      // A slash command is a turn boundary like any other user message, but it
      // renders as a command chip rather than as its raw XML wrapper.
      const cmd = commandOf(e);
      if (cmd) {
        open(e.timestamp ?? null).entries.push({ kind: 'command', name: cmd.name, args: cmd.args });
        continue;
      }
      const text = userText(e);
      if (text === null) continue;

      // Claude Code writes its own plumbing as `user` entries too — the /clear
      // caveat, goal Stop-hook notices, command stdout. Rendering those as
      // things the human said is wrong, and none of them starts a turn.
      const stdout = STDOUT_RE.exec(text.trim());
      if (e.isMeta || stdout) {
        const body = (stdout?.[1] ?? text).trim();
        const turn = current ?? open(e.timestamp ?? null);
        if (body) turn.entries.push({ kind: 'system', text: body });
        continue;
      }

      open(e.timestamp ?? null).entries.push({ kind: 'user', text });
      continue;
    }
    if (e.type !== 'assistant') continue;

    const turn = current ?? open(e.timestamp ?? null);

    // A failed request replaces the whole response, so it is the entry rather
    // than a block within one. Rendering it as prose would make an outage read
    // as something the agent said.
    if (e.isApiErrorMessage) {
      const text = entryText(e).trim();
      if (text) turn.entries.push({ kind: 'error', text });
      continue;
    }

    for (const b of blocks(e)) {
      if (b.type === 'text' && b.text?.trim()) {
        turn.entries.push({ kind: 'text', text: b.text });
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        turn.entries.push({ kind: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use' && b.name) {
        turn.entries.push(toolEntry(b, results, agentMeta, cwd));
      }
    }
  }

  return turns;
}

/**
 * A subagent call renders from the parent's own result metadata — agent type,
 * duration, tool count — so the collapsed row costs no extra file read. The
 * subagent transcript runs to hundreds of kilobytes and is only opened when
 * the row is expanded.
 */
function toolEntry(
  b: Block,
  results: Map<string, { text: string | null; ok: boolean }>,
  agentMeta: SubagentMeta,
  cwd: string,
): FeedEntry {
  const input = b.input ?? {};
  const outcome = b.id ? results.get(b.id) : undefined;

  if (b.name === 'Agent' || b.name === 'Task') {
    const meta = b.id ? agentMeta.get(b.id) : undefined;
    return {
      kind: 'agent',
      agentType: meta?.agentType ?? str(input.subagent_type) ?? 'agent',
      description: str(input.description) ?? clip(str(input.prompt) ?? '', 60),
      durationMs: meta?.durationMs ?? null,
      toolUseCount: meta?.toolUseCount ?? null,
      agentId: meta?.agentId ?? null,
    };
  }

  return {
    kind: 'tool',
    name: b.name ?? 'tool',
    summary: summarise(b.name ?? '', input, cwd),
    detail: outcome?.text ?? null,
    ok: outcome ? outcome.ok : null,
    sql: sqlOf(b.name ?? '', input),
  };
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Subagent metrics live on the PARENT's tool result, keyed by tool_use id.
 * Collected separately so `feedTurns` stays a pure projection of content blocks.
 */
interface SubagentOutcome {
  agentId: string | null;
  agentType: string | null;
  durationMs: number | null;
  toolUseCount: number | null;
  /** What the subagent returned — the tool_result body of the same entry. */
  output: string | null;
}

type SubagentMeta = Map<string, SubagentOutcome>;

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

/**
 * Every subagent of one agent, newest work last.
 *
 * Listed from the subagents DIRECTORY, not from the parent's tool calls. The
 * parent records a subagent only when it finishes — `toolUseResult` carries the
 * agentId, duration and tool count — so a list built from tool results is
 * structurally blind to the one subagent you actually want to watch. The
 * directory has a file from the moment a subagent starts: of 22 files on this
 * machine, two have no completion record in the parent at all, one of them 110
 * entries long, which is only possible because the file is appended as it runs.
 *
 * Status is derived, never reported. `finished` is the only verified state.
 * The rest read the PARENT's Herdr status, because a subagent has no pane and
 * its permission prompts are answered on the parent's.
 */
export function subagentRows(
  parentEntries: Entry[],
  transcriptPath: string,
  cwd: string,
  parentStatus: AgentStatus,
  cache: Transcripts,
): SubagentRow[] {
  const dir = subagentDirFor(transcriptPath);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return []; // no subagents have run, which is the common case
  }

  // Keyed by agentId rather than by tool_use id: the directory is the index
  // here, and the parent's record is what we enrich it with.
  const finished = new Map<string, SubagentOutcome>();
  for (const m of subagentMeta(parentEntries).values()) {
    if (m.agentId) finished.set(m.agentId, m);
  }

  const rows: SubagentRow[] = [];
  for (const file of files) {
    const agentId = AGENT_FILE.exec(file)?.[1];
    if (!agentId) continue;

    // Incrementally tailed, so listing costs one full parse per subagent and
    // then only its appended tail — the transcripts run to hundreds of KB.
    const entries = cache.entries(join(dir, file));
    if (entries.length === 0) continue;

    const done = finished.get(agentId);
    const startedAt = entries[0]?.timestamp ?? null;
    const updatedAt = entries[entries.length - 1]?.timestamp ?? null;

    rows.push({
      agentId,
      agentType: attributionOf(entries) ?? done?.agentType ?? 'agent',
      description: clip(promptOf(entries) ?? '', 80),
      status: done
        ? 'finished'
        : parentStatus === 'blocked' ? 'waiting'
        : parentStatus === 'working' ? 'running'
        : 'stopped',
      activity: activityOf(entries, cwd),
      output: done?.output ?? null,
      durationMs: done?.durationMs ?? elapsed(startedAt, updatedAt),
      toolUseCount: countToolUses(entries),
      startedAt,
      updatedAt,
    });
  }

  // The order they were spawned, which is the order they are talked about.
  return rows.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
}

/** The subagent's own name for itself, written on its assistant entries. */
function attributionOf(entries: Entry[]): string | null {
  for (const e of entries) {
    if (typeof e.attributionAgent === 'string' && e.attributionAgent) return e.attributionAgent;
  }
  return null;
}

/** The prompt it was handed: its first entry, which is always the request. */
function promptOf(entries: Entry[]): string | null {
  for (const e of entries) {
    if (e.type === 'user') return userText(e);
  }
  return null;
}

function countToolUses(entries: Entry[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    for (const b of blocks(e)) if (b.type === 'tool_use') n++;
  }
  return n;
}

function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function subagentMeta(entries: Entry[]): SubagentMeta {
  const out: SubagentMeta = new Map();
  for (const e of entries) {
    const r = e.toolUseResult;
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.agentId !== 'string') continue;
    for (const b of blocks(e)) {
      if (b.type === 'tool_result' && b.tool_use_id) {
        out.set(b.tool_use_id, {
          agentId: rec.agentId,
          agentType: str(rec.agentType),
          durationMs: typeof rec.totalDurationMs === 'number' ? rec.totalDurationMs : null,
          toolUseCount: typeof rec.totalToolUseCount === 'number' ? rec.totalToolUseCount : null,
          output: resultText(b.content),
        });
      }
    }
  }
  return out;
}
