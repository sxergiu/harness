import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeFileState } from '@harness/shared';

/**
 * The files `rules.ts` depends on but cannot carry. Rule 4 tells every agent to
 * delegate planning to a `planner` subagent, and Claude Code loads that from
 * `~/.claude/agents/planner.md` — a file on the human's machine, not something
 * this process can pass. Passing the same prompt as `--agents` JSON was tried
 * and gives it only to agents the cockpit started, which is the wrong half.
 *
 * The same goes for `/feature` and `/investigate`: the board reads an
 * assignment back off the transcript and shows it as a chip, so without the
 * command files that whole surface is inert.
 *
 * So they ship, and `harness init` puts them where Claude Code looks.
 *
 * Every file of Claude Code's OWN that this process reads or writes lives here
 * too — the trust grant in `~/.claude.json`, and `~/.claude/settings.json`,
 * which is read for the model in force and written only to put back what a
 * per-agent switch overwrote.
 */

/**
 * Beside this module in the source tree and beside the bundle in `dist/` —
 * `import.meta.url` is left alone by esbuild, which is the same trick `webRoot`
 * in `index.ts` already relies on for the built page.
 *
 * Read as files rather than imported as text: a text loader works under esbuild
 * and breaks `tsx`, and `tsx` is `npm run dev`, `npm test` and the server's own
 * start script. That is the three-resolver trap the shared package is kept to
 * one file to avoid.
 */
const ASSETS = new URL('./assets/', import.meta.url);

/** Where Claude Code looks. `agents/` and `commands/` are its own convention. */
const FILES = [
  { asset: 'planner.md', target: join('agents', 'planner.md') },
  { asset: 'feature.md', target: join('commands', 'feature.md') },
  { asset: 'investigate.md', target: join('commands', 'investigate.md') },
] as const;

/**
 * `wrote` — it was missing, or force replaced it. `identical` — already ours.
 * `kept` — the human's own version is there and differs, so it stands.
 */
export type Outcome = 'wrote' | 'identical' | 'kept';

/**
 * Pure so it can be tested without a home directory, and small enough to read
 * in one go — overwriting someone's own `planner.md` is silent and theirs to
 * discover, so the decision is worth being able to see whole.
 */
export function decide(existing: string | null, shipped: string, force: boolean): Outcome {
  if (existing === null) return 'wrote';
  if (existing === shipped) return 'identical';
  return force ? 'wrote' : 'kept';
}

export function claudeFiles(): ClaudeFileState[] {
  return FILES.map(({ asset, target }) => {
    const path = join(homedir(), '.claude', target);
    const text = assetText(asset);
    const existing = read(path);
    // `unavailable` is a broken install of the harness rather than a fact about
    // the human's file, and it must not throw: one read feeds all four panels of
    // the settings screen, so an asset missing from the build would otherwise
    // black out rules and checkouts too.
    if (text === null) return { name: target, path, status: 'unavailable' };
    return {
      name: target,
      path,
      status: existing === null ? 'missing' : existing === text ? 'ours' : 'differs',
    };
  });
}

/**
 * Writes every file that is missing, keeps every one the human has changed.
 * Returns what happened to each, because "kept" is the interesting answer and
 * silence about it would read as success.
 */
export function installClaudeFiles(
  force = false,
): Array<ClaudeFileState & { outcome: Outcome | 'unavailable' }> {
  return FILES.map(({ asset, target }) => {
    const path = join(homedir(), '.claude', target);
    const text = assetText(asset);
    if (text === null) {
      return { name: target, path, status: 'unavailable', outcome: 'unavailable' };
    }
    const existing = read(path);
    const outcome = decide(existing, text, force);
    if (outcome === 'wrote') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return { name: target, path, status: outcome === 'kept' ? 'differs' : 'ours', outcome };
  });
}

/**
 * Accept Claude Code's workspace trust for a folder, ahead of starting an agent
 * in it. Only ever called with a folder the harness itself owns.
 *
 * Claude Code asks "Is this a project you created or one you trust?" the first
 * time it starts interactively anywhere untrusted, and the agent sits at that
 * dialog until something answers. For the usage agent that is invisible twice
 * over — it is kept off the board on purpose — and the `/usage` that follows is
 * typed at a security dialog rather than into a prompt box, where Enter lands
 * on whichever option the dialog happens to default to.
 *
 * Claude Code names this exact escape itself, in the message it prints when a
 * workspace is untrusted: run it here once and accept, "or set
 * projects[<path>].hasTrustDialogAccepted: true in ~/.claude.json".
 *
 * **TRUST IS INHERITED BY EVERY DESCENDANT.** Measured: a directory created
 * seconds earlier under a trusted one opens with no dialog at all, while the
 * same directory under an untrusted parent shows it. So the folder granted here
 * is `~/.harness` and never the home directory the usage agent used to run in —
 * that grant would have silently trusted the human's entire home tree, which is
 * their decision to make and not a side effect of pressing a button.
 *
 * Best-effort and idempotent. The file is Claude Code's own and every running
 * agent writes it, so it is left completely alone unless the flag is actually
 * missing — in practice one write, ever. A file that is absent or unparseable
 * is not ours to create: no Claude Code has run yet, so the trust dialog is the
 * least of what the agent is about to meet.
 */
export function trustFolder(dir: string): void {
  const path = join(homedir(), '.claude.json');
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const projects = (config.projects ??= {});
    const project = (projects[dir] ??= {});
    if (project.hasTrustDialogAccepted === true) return;
    project.hasTrustDialogAccepted = true;

    // Rename, so an agent reading it mid-write gets the old file rather than
    // half of the new one — this is where its credentials live.
    const tmp = `${path}.harness-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Falls back to the dialog, which is where this started.
  }
}

// ---------------------------------------------------------------------------
// ~/.claude/settings.json
// ---------------------------------------------------------------------------

const SETTINGS = join(homedir(), '.claude', 'settings.json');

/** mtime of the settings we last parsed, so this is one stat per resync. */
let settingsAt = -1;
let settingsAlias: string | null = null;
let settingsEffort: string | null = null;

/**
 * Both halves of `~/.claude/settings.json` the cockpit reads, parsed together
 * against one mtime — a second reader would be a second stat for a file this is
 * already holding open.
 */
function readSettings(): void {
  try {
    const { mtimeMs } = statSync(SETTINGS);
    if (mtimeMs === settingsAt) return;
    settingsAt = mtimeMs;
    const s = JSON.parse(readFileSync(SETTINGS, 'utf8')) as { model?: unknown; effortLevel?: unknown };
    settingsAlias = typeof s.model === 'string' ? s.model : null;
    settingsEffort = typeof s.effortLevel === 'string' ? s.effortLevel : null;
  } catch {
    // No settings file, or one we cannot parse — no alias, and `windowFor`
    // answers the smaller window, which is the safe read for the same reason.
  }
}

/**
 * The model `~/.claude/settings.json` names — the alias in force for anything
 * the cockpit did not start with a `--model` of its own, and the file a live
 * `/model` rewrites.
 */
export function configuredAlias(): string | null {
  readSettings();
  return settingsAlias;
}

/**
 * The effort in force, under `effortLevel` rather than `effort`. This is the
 * whole of the cockpit's effort default: agents start with no `--effort`, so
 * what this file says is what they run at.
 */
export function configuredEffort(): string | null {
  readSettings();
  return settingsEffort;
}

/** The two keys a per-agent switch moves, and the only ones ever written here. */
export type SettingKey = 'model' | 'effortLevel';

export interface Hold {
  /** What the switch is about to write — and so the signal that it has landed. */
  want: string;
  /** What the key held before the FIRST switch; null when it held nothing. */
  restoreTo: string | null;
  expires: number;
}

/**
 * How long a switch may take to land. A `/model` at a busy agent queues behind
 * the current turn, so this is a turn's worth of patience and not a round trip.
 */
export const HOLD_MS = 10 * 60_000;

const held = new Map<SettingKey, Hold>();

/**
 * Hold the machine-wide default still across a switch of ONE agent.
 *
 * `/model` and `/effort` are not per-agent: Claude Code sets the session and
 * writes the alias to `~/.claude/settings.json` as the default for new sessions
 * — measured against v2.1.220, where both commands reach the same user-settings
 * writer whenever the session is interactive, which a Herdr pane always is. So
 * the switch is sent, the write is allowed to land, and the key is then put
 * back to what it said before.
 *
 * Keyed on the SETTING rather than on the pane: two agents switched at once are
 * two writes to one key, and the second must still restore what the FIRST one
 * found — restoring to the value the second switch saw would leave the first
 * agent's alias standing as the machine default, which is the whole bug.
 *
 * A switch to what the file already says has nothing to defend and takes no
 * hold, which also keeps `settleHolds` from writing a value back over itself.
 */
export function hold(key: SettingKey, want: string, restoreTo: string | null): void {
  const next = holdFor(held.get(key), want, restoreTo, Date.now());
  if (next !== null) held.set(key, next);
}

/** Split out pure for `settleAction`'s reason: it fails the same way, silently. */
export function holdFor(
  open: Hold | undefined, want: string, restoreTo: string | null, now: number,
): Hold | null {
  if (want === restoreTo) return null;
  return { want, restoreTo: open ? open.restoreTo : restoreTo, expires: now + HOLD_MS };
}

/**
 * Whether the write we are waiting on has landed yet. Pure, because all three
 * answers look identical on screen: restoring too early leaves the switch's own
 * value standing as the default a moment later, and never restoring at all is
 * indistinguishable from a cockpit that never tried.
 */
export function settleAction(
  current: string | null, hold: Hold, now: number,
): 'wait' | 'restore' | 'give-up' {
  if (current === hold.want) return 'restore';
  return now >= hold.expires ? 'give-up' : 'wait';
}

/**
 * Put back whatever a landed switch overwrote. Called from the board's resync
 * rather than from a timer of its own: that heartbeat already runs every few
 * seconds and already reads this file, there is nothing to cancel at shutdown
 * or when a second switch arrives, and a `/model` that sat queued behind a long
 * turn is still caught whenever it finally runs. Restoring on a fixed delay is
 * the trap — it fires before the CLI's write and leaves the file moved anyway.
 *
 * In memory, so a harness restarted inside the window leaves the default moved.
 * That is what happened before any of this existed, and it is the same reason
 * `stateSince` is legitimately empty after a restart.
 */
export function settleHolds(): void {
  if (held.size === 0) return;
  readSettings();
  const now = Date.now();
  for (const [key, hold] of held) {
    const current = key === 'model' ? settingsAlias : settingsEffort;
    const action = settleAction(current, hold, now);
    if (action === 'wait') continue;
    if (action === 'restore') writeSetting(key, hold.restoreTo);
    held.delete(key);
  }
}

/**
 * One key of Claude Code's own settings, left exactly as `trustFolder` leaves
 * `~/.claude.json`. Re-read immediately before writing and only the one key
 * touched, so everything a running agent changed meanwhile survives — this file
 * is live-written by every one of them.
 *
 * The MODE is carried across, which writing through a temp file is exactly how
 * you lose: measured at 0600 on this machine, and a fresh temp file renamed
 * over it would publish a file the human had kept private, saying nothing.
 *
 * Best-effort: a failure costs the default its hold, never the switch that was
 * already sent.
 */
function writeSetting(key: SettingKey, value: string | null): void {
  try {
    const settings = JSON.parse(readFileSync(SETTINGS, 'utf8')) as Record<string, unknown>;
    if (value === null) delete settings[key];
    else settings[key] = value;

    const tmp = `${SETTINGS}.harness-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: statSync(SETTINGS).mode });
    renameSync(tmp, SETTINGS);
    settingsAt = -1; // our own write, so the next read must not trust the mtime
  } catch {
    // The default stays where the switch put it, which is where it stood before
    // any of this existed.
  }
}

/** Null when the assets are not beside the bundle — a `dist/` built before them. */
function assetText(asset: string): string | null {
  return read(fileURLToPath(new URL(asset, ASSETS)));
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
