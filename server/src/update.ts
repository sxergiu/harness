import { execFile } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { UpdateView } from '@harness/shared';
import { shimCommand } from './account.js';

/**
 * Moving this install onto the newest published version: asking the registry
 * what that is, and having npm put it where this process was started from.
 *
 * Only a GLOBAL npm install is ever offered the update, decided by comparing
 * where this code runs with where `npm install -g` would write — never by the
 * shape of the path. A checkout (`npm start`, `npm run dev`, `npm link`) or an
 * `npx` cache would each get a second copy installed beside it that nothing
 * ever runs, and `npx` lives under a `node_modules` too, which is what a
 * path-shape test would have got wrong.
 */

export const PACKAGE = '@sxergiu/harness';

const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE}/latest`;

/** Measured 0.4s warm and 3.3s cold; past this the registry is unreachable. */
const CHECK_TIMEOUT_MS = 5_000;

/** A dry run alone took 5s, and a slow mirror is not a failure. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;

/**
 * The version reaches a `cmd.exe /c` command line on Windows, unquoted (see
 * `shimCommand`), so anything not of this shape is refused rather than escaped.
 * None of `& | ^ < > " %` can match it.
 */
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

const execFileAsync = promisify(execFile);

async function npm(args: string[], timeout: number): Promise<string> {
  const [file, argv] = shimCommand('npm', args);
  const { stdout } = await execFileAsync(file, argv, { timeout, windowsHide: true });
  return stdout;
}

/**
 * `fetch` rather than `npm view`: no child process, no shim, and an obvious
 * timeout, at a tenth of the time. A custom `registry` in `.npmrc` is ignored
 * here and honoured by the install, which is why the install route checks what
 * actually landed rather than trusting this answer.
 */
export async function latestVersion(): Promise<string> {
  let body: { version?: unknown };
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json() as { version?: unknown };
  } catch (err) {
    throw new Error(`could not reach the npm registry: ${(err as Error).message}`);
  }
  if (typeof body.version !== 'string' || !SEMVER.test(body.version)) {
    throw new Error('the npm registry answered without a version');
  }
  return body.version;
}

/**
 * Compared as numbers, because as strings `0.10.0` sorts before `0.9.0` and
 * every update from 0.10 on would be hidden. A prerelease is older than its
 * release and otherwise not ordered — nothing here publishes one. Anything that
 * does not parse is never newer, so a garbled answer offers nothing.
 */
export function isNewer(latest: string | null, running: string | null): boolean {
  const a = latest === null ? null : SEMVER.exec(latest);
  const b = running === null ? null : SEMVER.exec(running);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(a[i]) - Number(b[i]);
    if (d !== 0) return d > 0;
  }
  return a[4] === undefined && b[4] !== undefined;
}

/**
 * The last answer, kept so a tab that connects is told without asking npm, and
 * shared by every asker while one is in flight — the daily timer and a `check`
 * press landing together are one request.
 */
let last: UpdateView | null = null;
let checking: Promise<UpdateView> | undefined;

export const lastCheck = (): UpdateView | null => last;

const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** A harness started at login can beat the network up; a day is too long to stay blind. */
const RETRY_FAILED_MS = 60 * 60_000;

/**
 * Judged on the wall clock against `checkedAt`, not by a 24h timer: timers run
 * on a monotonic clock that stops while a mac sleeps, so a laptop shut every
 * night would go days between checks.
 */
export function checkDue(now = Date.now()): boolean {
  if (last === null) return true;
  return now - Date.parse(last.checkedAt) >= (last.latest === null ? RETRY_FAILED_MS : CHECK_EVERY_MS);
}

/** Never throws: an unreachable registry is a line on the screen, not a broken one. */
export function checkForUpdate(running: string | null, packageRoot: string): Promise<UpdateView> {
  checking ??= Promise.all([
    latestVersion().then((v) => ({ v }), (err: Error) => ({ v: null, error: err.message })),
    updatable(packageRoot),
  ]).then(([latest, canUpdate]) => {
    last = {
      latest: latest.v,
      available: isNewer(latest.v, running),
      updatable: canUpdate,
      checkedAt: new Date().toISOString(),
      ...('error' in latest ? { error: latest.error } : {}),
    };
    return last;
  }).finally(() => { checking = undefined; });
  return checking;
}

/** Windows paths compare without case and either slash; `npm root -g` and `import.meta.url` disagree on both. */
export function sameDir(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+$/, '');
    return platform === 'win32' ? s.replace(/\\/g, '/').toLowerCase() : s;
  };
  return norm(a) === norm(b);
}

/**
 * Where `npm install -g` puts this package, or null when it is not there or is
 * an `npm link` — a link resolves to the checkout this runs from, and installing
 * would replace the link with a registry copy nothing then runs. A junction on
 * Windows reports as a link too.
 *
 * Memoized because it cannot move in a process's life and costs 1.6s, but an
 * npm that FAILED is not: one that timed out once would otherwise report a
 * global install as a checkout until restart.
 */
let globalRoot: Promise<string | null> | undefined;

export function updatable(packageRoot: string): Promise<boolean> {
  globalRoot ??= npm(['root', '-g'], CHECK_TIMEOUT_MS).then(
    (out) => {
      const at = join(out.trim(), PACKAGE);
      try {
        return lstatSync(at).isSymbolicLink() ? null : realpathSync(at);
      } catch {
        return null;
      }
    },
    () => { globalRoot = undefined; return null; },
  );
  return globalRoot.then((root) => root !== null && sameDir(root, packageRoot));
}

export async function install(version: string): Promise<void> {
  if (!SEMVER.test(version)) throw new Error(`not a version: ${version}`);
  try {
    await npm(['install', '-g', `${PACKAGE}@${version}`], INSTALL_TIMEOUT_MS);
  } catch (err) {
    throw new Error(installError(err, version));
  }
}

/**
 * npm's own lines, minus the pointer to its log. A permission refusal names the
 * command instead, since the one thing the cockpit cannot do is answer `sudo`
 * or close whatever holds a file open on Windows.
 */
function installError(err: unknown, version: string): string {
  const e = err as { code?: string; killed?: boolean; stderr?: string; message?: string };
  const stderr = e.stderr ?? '';
  // Through `cmd.exe` a missing npm is not ENOENT but exit 1 and this line.
  if (e.code === 'ENOENT' || /is not recognized/.test(stderr)) return 'npm is not on PATH';
  const byHand = `run \`npm install -g ${PACKAGE}@${version}\` yourself`;
  if (e.killed) return `npm did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes — ${byHand}`;
  const code = /^npm (?:error|ERR!) code (\S+)/m.exec(stderr)?.[1];
  if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
    const sudo = process.platform === 'win32' ? '' : ' (a root-owned global prefix needs sudo)';
    return `npm was refused (${code}) — ${byHand}${sudo}`;
  }
  const lines = stderr.split(/\r?\n/)
    .filter((l) => /^npm (?:error|ERR!)/.test(l) && !/complete log/i.test(l))
    .map((l) => l.replace(/^npm (?:error|ERR!) ?/, '').trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join(' · ') : (e.message ?? 'npm install failed');
}
