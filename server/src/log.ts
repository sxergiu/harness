import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * What a bug report has to attach.
 *
 * Always on, and never on stdout. The terminal stays as quiet as it was —
 * `logger: false` is still what Fastify is given — because the point is not to
 * narrate a working cockpit, it is that the ONE run that went wrong left a
 * record. Behind a flag it would not have: the person hits the fault, finds
 * nothing on disk, and has to reproduce it to get anything to send.
 *
 * So this is deliberately not a logger. There are no levels, no transports and
 * nothing structured: it takes errors, the facts needed to interpret them, and
 * nothing else, which is what keeps an always-on file small enough to be
 * capped rather than rotated.
 */

const PATH = join(homedir(), '.harness', 'harness.log');

/**
 * A cockpit left running for days must not fill a disk, and a report nobody can
 * open is no better than no report. Past this the file stops growing and says
 * so — the early lines are kept rather than the late ones, because the startup
 * facts and the first failure are what a report is read for, and a fault that
 * repeats ten thousand times has already been recorded the first time.
 */
const CAP_BYTES = 1_000_000;

let written = 0;
let capped = false;
/** Nothing is written until `logStart` has established the file can be. */
let ready = false;

/**
 * Truncates the log and records what this process is, which is most of what a
 * report needs before anything has gone wrong: a mismatch between the harness,
 * node, Herdr and the protocol explains a great many faults on its own.
 *
 * Failing to open the file costs the log and nothing else. It is a diagnostic —
 * an unwritable home must never be the reason a cockpit will not start.
 */
export function logStart(facts: Record<string, string | number | boolean | undefined>): void {
  try {
    mkdirSync(dirname(PATH), { recursive: true });
    writeFileSync(PATH, '');
    ready = true;
  } catch {
    return;
  }
  log(Object.entries(facts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(' '));
}

export function log(message: string): void {
  if (!ready || capped) return;
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    if (written + line.length > CAP_BYTES) {
      capped = true;
      appendFileSync(PATH, `${new Date().toISOString()} log capped at ${CAP_BYTES} bytes; nothing further is recorded\n`);
      return;
    }
    appendFileSync(PATH, line);
    written += line.length;
  } catch { /* the disk filled, or the home went away; never break the server */ }
}

/** Errors arrive as `unknown` from every catch in this codebase. */
export function logError(context: string, err: unknown): void {
  log(`${context}: ${err instanceof Error ? err.message : String(err)}`);
}
