import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BIND_HOST, DEV_PAGE_PORT } from '@harness/shared';

/**
 * "Is a harness already running, and where?" — the single-instance mutex, and
 * where the user gets pointed.
 *
 * Binding the port used to BE the mutex, which worked exactly as long as the
 * port was fixed. It no longer is: `--port` exists so that a machine already
 * using 4373 is not simply locked out, and the moment two instances can bind
 * two different ports the port stops locking anything. That is not a cosmetic
 * regression — under Herdr's newest-subscriber-wins rule (invariant 2) the
 * second instance silently and permanently starves the first of its event
 * stream, with both windows still open and one of them quietly coasting on its
 * heartbeat. So the lock moved here, and it is now the thing that is checked
 * first.
 *
 * The lockfile records WHERE to look; the probe decides whether anything is
 * there. Trusting the recorded pid instead would inherit pid reuse — an
 * unrelated process inheriting a dead harness's pid would make the cockpit
 * refuse to start, blaming an instance that does not exist. Asking the port
 * whether it is a harness answers the question actually being asked.
 */

const PATH = join(homedir(), '.harness', 'harness.lock');

/** Answered only by us, and the whole basis of the probe below. */
export const HEALTH_PATH = '/api/health';

/** Long enough for a loopback round trip, short enough not to stall a start. */
const PROBE_MS = 500;

export interface Instance {
  pid: number;
  port: number;
}

/**
 * What a running harness says about itself when asked. `page` and `viewers` are
 * there for one decision — whether a second invocation should open a browser —
 * and both are facts about this process rather than about the agents, which is
 * what keeps the endpoint answerable before any caller has been identified.
 */
export interface Health {
  harness: true;
  pid: number;
  /** Whether THIS process serves the cockpit page. False is the dev split. */
  page: boolean;
  /** Cockpit tabs connected right now, however they were served. */
  viewers: number;
}

export type Running = Instance & Pick<Health, 'page' | 'viewers'>;

export const urlFor = (port: number): string => `http://${BIND_HOST}:${port}`;

/**
 * The running harness, or null. A lockfile whose port does not answer as a
 * harness is stale — a previous run killed hard enough to skip `release` —
 * and is treated as absent rather than as a reason to refuse.
 */
export async function running(): Promise<Running | null> {
  const held = read();
  if (!held) return null;
  const live = await health(held.port);
  return live ? { ...held, page: live.page, viewers: live.viewers } : null;
}

/**
 * Where that instance's cockpit actually is, or null when it is nowhere.
 *
 * Built, it is the instance itself. In development the page is Vite's and the
 * API port answers `GET /` with a JSON 404 — which is what a second invocation
 * used to open a tab onto, every single time, until there were many. So the dev
 * page is offered only once something has answered on it: a tab onto a port
 * nothing is serving is the same mistake with a different error on it.
 */
export async function pageOf(instance: Running): Promise<string | null> {
  if (instance.page) return urlFor(instance.port);
  const dev = urlFor(DEV_PAGE_PORT);
  return (await responds(dev)) ? dev : null;
}

/**
 * Whether a second invocation should open a tab onto the instance already
 * running. Both conditions are load-bearing, and the second one is the one that
 * was learned the hard way — twice.
 *
 * `viewers` alone is NOT enough, and its own guard is what proved it: the count
 * reads 0 for the second after any restart, while the cockpit's sockets are
 * dropped and have not yet retried. `npm run dev` respawns the server on every
 * save straight into this check, so a watcher can win that race repeatedly and
 * each win is another tab. Waiting and re-probing does not fix it either — the
 * browser's retry is itself 1000ms, so any delay short enough to keep this
 * command fast is a coin flip against it.
 *
 * So a DEV instance is never opened automatically at all. Its page is Vite's,
 * which the human opened themselves and still has; there is nothing to restore
 * and the URL on stdout is the whole of what they need. Only a built instance —
 * one that serves its own page, and which no watcher is respawning — can be
 * opened, and then only when nobody is looking at it.
 */
export function shouldOpen(instance: Running): boolean {
  return instance.page && instance.viewers === 0;
}

/**
 * Records this process as the running harness. Best-effort on purpose: an
 * unwritable home should cost the mutex, never the ability to start. The
 * caller warns when this returns false, because a silent loss of the lock is
 * exactly the invisible-second-instance problem the lock exists to prevent.
 */
export function claim(port: number): boolean {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, JSON.stringify({ pid: process.pid, port } satisfies Instance));
    return true;
  } catch {
    return false;
  }
}

/** Drops the lock, but only if it is still ours — never a successor's. */
export function release(): void {
  try {
    if (read()?.pid === process.pid) rmSync(PATH, { force: true });
  } catch { /* going away anyway */ }
}

function read(): Instance | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(PATH, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { pid, port } = parsed as Record<string, unknown>;
    if (!Number.isInteger(pid) || !Number.isInteger(port)) return null;
    return { pid: pid as number, port: port as number };
  } catch {
    return null;
  }
}

/**
 * What is listening on `port`, if it is a harness at all — null covers both
 * "nothing there" and "something there that is not one of ours".
 *
 * Every field is defaulted rather than trusted: this is an unauthenticated
 * local port, and an older harness answering the same probe carries neither of
 * the newer two. A missing `page` reading as false costs a browser tab that
 * would have opened; a missing one reading as true costs the 404 tab this is
 * here to stop.
 */
async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`${urlFor(port)}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<Health>;
    if (body.harness !== true) return null;
    return {
      harness: true,
      pid: Number(body.pid) || 0,
      page: body.page === true,
      viewers: Number(body.viewers) || 0,
    };
  } catch {
    return null;
  }
}

/** Whether anything at all is serving there, for a page we did not write. */
async function responds(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) })).ok;
  } catch {
    return false;
  }
}

/**
 * Opens the cockpit. Used by BOTH the start path and the already-running path,
 * which is the whole reason it lives here: a second invocation should land you
 * in the harness you already have rather than tell you off.
 */
export function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer'
    : 'xdg-open';
  try {
    const p = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    // A headless box has no opener, and that must not take the server with it —
    // the URL is on stdout regardless.
    p.on('error', () => {});
    p.unref();
  } catch { /* ignore */ }
}
