import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * What the human has decided about a CHECKOUT, keyed by its resolved path.
 *
 * The key is the whole design. A space's directory is deliberately never
 * persisted — Herdr recycles workspace ids, so a dir remembered against one
 * could start an agent in the wrong repo (see `Board.dirs`). A filesystem path
 * has no such problem: it means the same thing in every session, on every
 * restart, which is what makes a grant safe to keep here and unsafe to keep on
 * a row.
 *
 * Two spaces pointed at one repo therefore share one grant, and that is
 * correct: the thing being delegated is the git history of a checkout, not a
 * property of whichever space happens to be looking at it.
 */

const PATH = join(homedir(), '.harness', 'projects.json');

/**
 * Bumped only when the shape changes in a way an older reader would
 * misinterpret. A file from any other version is discarded rather than
 * migrated: this holds grants, and the cost of discarding one is that the human
 * re-ticks a box, where the cost of misreading one is an agent committing
 * somewhere it was never allowed to.
 */
const VERSION = 1;

/**
 * `autoAccept` arrived without a bump, and needed none: an older reader checks
 * `gitDelegated === true` and nothing else, so it reads an auto-accept-only
 * entry as no grant at all — the refusing direction.
 */
export interface Checkout {
  gitDelegated: boolean;
  /** Agents started here run with `--permission-mode bypassPermissions`. */
  autoAccept: boolean;
}

const NONE: Checkout = { gitDelegated: false, autoAccept: false };

export class Projects {
  private checkouts = new Map<string, Checkout>();

  constructor() {
    try {
      this.checkouts = parse(readFileSync(PATH, 'utf8'));
    } catch { /* first run, or a file we can no longer read — start with no grants */ }
  }

  /**
   * What agents started in this checkout may do without asking: commit and
   * push, and skip every permission prompt. Everything not granted is refused,
   * including anything this store could not make sense of.
   */
  grantOf(dir: string): Checkout {
    return this.checkouts.get(resolve(dir)) ?? NONE;
  }

  /** Changes only the grants `patch` names. */
  setGrant(dir: string, patch: Partial<Checkout>): void {
    const path = resolve(dir);
    const before = this.checkouts.get(path);
    const next = { ...this.grantOf(path), ...patch };
    if (next.gitDelegated || next.autoAccept) this.checkouts.set(path, next);
    // A revoked grant leaves nothing behind: the entry IS the grant, and an
    // empty record would only accumulate paths the human has finished with.
    else this.checkouts.delete(path);
    try {
      this.save();
    } catch (err) {
      // Revoking auto-accept is a refusal, so an unsaved revoke would hand
      // bypass back at the next restart with nothing on screen saying so.
      if (before) this.checkouts.set(path, before);
      else this.checkouts.delete(path);
      throw err;
    }
  }

  /** Every checkout the human has decided something about. For the settings screen. */
  all(): Array<{ path: string } & Checkout> {
    return [...this.checkouts]
      .map(([path, c]) => ({ path, ...c }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private save(): void {
    mkdirSync(dirname(PATH), { recursive: true });
    const checkouts = Object.fromEntries(this.checkouts);
    writeFileSync(PATH, JSON.stringify({ version: VERSION, checkouts }, null, 2));
  }
}

/**
 * Every field is checked, and anything unrecognised yields NO grants rather
 * than a guess. A store that reads a shape it does not understand and answers
 * `true` is silent by construction: the board looks identical either way, and
 * the first sign of it is a commit in a repository nobody delegated.
 */
export function parse(text: string): Map<string, Checkout> {
  const out = new Map<string, Checkout>();
  const doc = JSON.parse(text) as unknown;
  if (typeof doc !== 'object' || doc === null) return out;

  const { version, checkouts } = doc as { version?: unknown; checkouts?: unknown };
  if (version !== VERSION) return out;
  if (typeof checkouts !== 'object' || checkouts === null) return out;

  for (const [path, value] of Object.entries(checkouts)) {
    // Relative keys cannot be matched against a resolved lookup, so a file that
    // holds one was not written by us.
    if (path !== resolve(path)) continue;
    const v = value as Partial<Record<keyof Checkout, unknown>> | null;
    const grant = { gitDelegated: v?.gitDelegated === true, autoAccept: v?.autoAccept === true };
    if (grant.gitDelegated || grant.autoAccept) out.set(path, grant);
  }
  return out;
}
