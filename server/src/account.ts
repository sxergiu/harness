import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AccountIdentity, type AccountKey, type AccountView, type KnownAccount, sameAccount,
} from '@harness/shared';
import { trustFolder } from './claudeFiles.js';
import type { Herdr } from './herdr.js';

/**
 * Which Claude account the agents are spending, and how to swap it for another
 * when this one runs out.
 *
 * **The harness handles no credentials.** It drives the Claude Code CLI's own
 * auth surface and reads its stdout — `claude auth status --json`, `logout`,
 * `login` — and never reads or writes the keychain slot the tokens live in
 * (macOS: service `Claude Code-credentials`) or the `oauthAccount` block in
 * `~/.claude.json`. A design that parked and restored credential blobs would
 * have switched accounts without a browser; it was offered and declined, and
 * everything here follows from that.
 *
 * So a switch is `logout` then `login`, the login runs in a pane the human can
 * see, and the only way to know it worked is to ask `claude auth status` again.
 *
 * Nothing here touches an agent. A running agent keeps whatever token it already
 * holds, and the cockpit neither stops, restarts nor prompts one — which is why
 * the panel says so rather than leaving it to be discovered.
 */

const CLI_TIMEOUT_MS = 15_000;

/** How long a login may sit unfinished before the panel stops waiting on it. */
const STALL_MS = 5 * 60_000;

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------

/**
 * Same discipline as `cli()` in `herdr.ts` — argv array never a shell string,
 * a timeout, and a `claude` resolved off PATH — but async, which that one can
 * afford not to be and this cannot. `cli()` runs twice in a process and caches
 * both answers; this runs on every read of the panel and every two seconds
 * while a login is pending, and it measures ~0.3s. Blocking the event loop for
 * that would stall the 3s heartbeat that is the board's whole liveness.
 */
async function claude(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('claude', args, {
    timeout: CLI_TIMEOUT_MS, windowsHide: true,
  });
  return stdout;
}

/** Whatever the CLI said went wrong, in the fewest words that still locate it. */
function reason(err: unknown): string {
  const e = err as { code?: string; stderr?: string; message?: string };
  if (e.code === 'ENOENT') return 'the claude CLI is not on PATH';
  return (e.stderr ?? '').trim() || e.message || 'unknown error';
}

/**
 * Who Claude Code says it is signed in as, or null when it did not answer in a
 * shape this understands.
 *
 * **Every field is checked and anything unexpected is null**, the same posture
 * as `goalOf` and for a sharper reason: the whole switch is decided on this
 * parse. A loose one — truthy-casting `loggedIn`, defaulting `email` to `''` —
 * makes a login that never happened look finished, which closes the pane the
 * human was in the middle of using and reports the account as switched while
 * every request still goes out on the old one. None of that is visible on
 * screen.
 *
 * `{loggedIn: false}` is a real answer and parses to a null IDENTITY, which is
 * a different thing from this function's null: one means nobody is signed in,
 * the other means we do not know.
 */
export function statusOf(stdout: string): { current: AccountIdentity | null } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;

  const d = doc as Record<string, unknown>;
  if (typeof d.loggedIn !== 'boolean') return null;
  if (!d.loggedIn) return { current: null };
  if (typeof d.email !== 'string' || d.email === '') return null;

  return {
    current: {
      email: d.email,
      orgId: field(d.orgId),
      orgName: field(d.orgName),
      subscriptionType: field(d.subscriptionType),
    },
  };
}

/** Display fields only: a missing one costs a word on screen, never the parse. */
const field = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/**
 * An email is only ever passed to `--email` to pre-fill the login page, and it
 * gets there by being TYPED AT A SHELL — `launchCommand` has no argv to hand it
 * to (there is no Herdr method that takes one). So it is checked against the
 * shape of an address before it goes on a command line, and dropped rather than
 * quoted if it is anything else. Every address here came out of `claude auth
 * status`, so this is not expected to fire; it is here because the one place a
 * string from another process reaches a shell is worth closing whether or not
 * anything is coming through it.
 */
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// ---------------------------------------------------------------------------
// The accounts we have seen
// ---------------------------------------------------------------------------

const PATH = join(homedir(), '.harness', 'accounts.json');

/**
 * Bumped when the shape changes in a way an older reader would misread. This
 * takes `recent.json`'s tolerant policy rather than `projects.json`'s discarding
 * one, and the asymmetry between those two is the reason: a grant misread hands
 * an agent permission it was never given, where a row misread here pre-fills the
 * wrong address on a login page the human is looking at and can correct. Nothing
 * is authorized by this file. The live account always comes from `claude auth
 * status` and never from here.
 *
 * 2 added `orgId`. A version-1 row cannot be migrated by defaulting it to null,
 * which is why this is a bump and not a tolerated absence: the same account read
 * back with no org never matches the live one, so it would sit in the list
 * forever as a phantom second copy of the account you are already on. Discarding
 * costs nothing — the next read captures whoever is signed in.
 */
const VERSION = 2;

class Accounts {
  private rows: KnownAccount[] = [];

  constructor() {
    try {
      this.rows = parse(readFileSync(PATH, 'utf8'));
    } catch { /* first run, or a file we can no longer read — start empty */ }
  }

  all(): KnownAccount[] {
    return this.rows;
  }

  find(key: AccountKey): KnownAccount | undefined {
    return this.rows.find((r) => sameAccount(r, key));
  }

  /**
   * Blank clears it, so emptying the box restores the address rather than
   * storing "". False when no such account, which the route answers as a 404 —
   * silently doing nothing would hand back the whole view with the old name
   * still on it and nothing anywhere saying why.
   */
  setLabel(key: AccountKey, label: string): boolean {
    const row = this.find(key);
    if (!row) return false;
    row.label = label.trim() || null;
    this.save();
    return true;
  }

  /**
   * Record whoever is signed in, newest first. This is the whole of enrolment:
   * an account joins the list by being used, so the one you are on is there
   * without anyone adding it, and a new one joins the first time you log into
   * it. The order is the only record of recency and needs no timestamp beside
   * it — the file is rewritten in it.
   */
  capture(identity: AccountIdentity): void {
    // **The label is carried over.** It is the one field `claude auth status`
    // cannot report, and a capture runs on every read of the panel — every two
    // seconds while a login is open — so taking the identity wholesale would
    // erase a rename within a tick of making it.
    const row: KnownAccount = { ...identity, label: this.find(identity)?.label ?? null };

    // Called that often, an account already at the head is not rewritten. The
    // label is not compared: `row` took it from this same account, so it would
    // be a tautology and would read as the thing protecting a rename, which is
    // the carry-over above.
    const head = this.rows[0];
    if (head && sameAccount(head, row) && head.orgName === row.orgName
      && head.subscriptionType === row.subscriptionType) return;

    // `sameAccount`, never the email: filtering on the address alone made a
    // second account at the same one REPLACE the first, so the list could never
    // hold both and there was nothing to switch to.
    this.rows = [row, ...this.rows.filter((r) => !sameAccount(r, identity))];
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      writeFileSync(PATH, JSON.stringify({ version: VERSION, accounts: this.rows }, null, 2));
    } catch { /* an unwritable home costs the list, never the ability to switch */ }
  }
}

/**
 * `email` is the only field a row cannot do without: it is the key, the only
 * thing the row renders, and the only thing `--email` can be given. A row
 * without one is an entry that cannot be shown or switched to.
 */
function parse(text: string): KnownAccount[] {
  const doc = JSON.parse(text) as { version?: unknown; accounts?: unknown };
  if (typeof doc !== 'object' || doc === null || doc.version !== VERSION) return [];
  if (!Array.isArray(doc.accounts)) return [];

  return doc.accounts
    .filter((r: unknown): r is KnownAccount =>
      typeof r === 'object' && r !== null && typeof (r as KnownAccount).email === 'string')
    // Only `email` is asserted above, so the two fields that are COMPARED are
    // normalised here rather than trusted. `orgId` matters most: `sameAccount`
    // uses `===`, so a row carrying `undefined` where we write null is one
    // `find` can never return — unrenameable, never matching the live account,
    // and duplicated by the next capture, which is the phantom-row failure the
    // version-2 bump was taken to avoid arriving by the other door.
    // `label` needs no bump of its own: absent simply means never renamed, and
    // `field` maps a blank one to that rather than to a row with no visible
    // identity at all.
    .map((r) => ({ ...r, orgId: field(r.orgId), label: field(r.label) }));
}

// ---------------------------------------------------------------------------
// Reading it, and changing it
// ---------------------------------------------------------------------------

/**
 * In memory only, and legitimately empty after a restart — the same standing as
 * `stateSince` and a row's shade. What it costs is specific and worth stating:
 * a harness restarted inside the few minutes a login is open forgets it, and
 * the pane is then nobody's. It stays on screen in Herdr for the human to
 * finish or close, which is the whole reason it is a visible pane, and the next
 * switch opens a second one beside it. Adopting it back the way `usage.ts`
 * adopts its agent is not available: that works by AGENT name, and this pane
 * hosts a shell that Herdr knows no name for.
 */
interface Pending {
  /** What the login page was asked to pre-fill, if anything. */
  email: string | null;
  paneId: string;
  /** The account we signed out of — one of the two ways to tell a login landed. */
  from: AccountIdentity | null;
  /** Whether `status` has confirmed the logout. See `settle`. */
  sawLoggedOut: boolean;
  since: number;
}

export class Account {
  private pending: Pending | null = null;
  private readonly accounts = new Accounts();

  constructor(private readonly herdr: Herdr) {}

  /**
   * The whole surface, and the only thing that finishes a pending login.
   *
   * **There is no timer behind this.** A switch is finished by somebody reading
   * the view — the browser polls while a login is pending, and `↻` is the same
   * call — so the completion check lives in one place that both routes already
   * go through. A poller of its own would be a second thing deciding the same
   * question, and it would have to be cancelled on shutdown, on abandon and on
   * a second switch.
   */
  async view(): Promise<AccountView> {
    const status = await this.status();
    if (status !== null) await this.settle(status.current);
    // Enrolment, and the only place it happens for an account nobody switched
    // to from here: whoever is signed in is on the list by virtue of being read
    // about. Without this the list is empty until the first switch — which is
    // the switch that has nothing to offer.
    if (status?.current) this.accounts.capture(status.current);

    return {
      available: status !== null,
      // Resolved here rather than in the browser: the capture above guarantees
      // the live account is on the list, so its stored name is one lookup away
      // and the panel never has to work out which row it is looking at.
      current: status?.current ? this.accounts.find(status.current) ?? null : null,
      known: this.accounts.all(),
      pending: this.pending && {
        email: this.pending.email,
        stalled: Date.now() - this.pending.since > STALL_MS,
      },
    };
  }

  /**
   * Log out, then open a visible pane logging in — in that order, because the
   * CLI holds one account at a time and there is nothing to log into until the
   * current one is gone.
   *
   * That ordering has one hole and it is unavoidable: between the logout landing
   * and the pane existing, a Herdr that fails leaves the human logged out with
   * nothing on screen to finish in. The error says so in words rather than
   * leaving it to be worked out.
   */
  async switchTo(email: string | null): Promise<AccountView> {
    if (this.pending) throw new Error('a login is already waiting in a pane');

    const status = await this.status();
    if (status === null) throw new Error('claude auth status did not answer — is claude on PATH?');

    // Nothing to sign out of when nobody is signed in, and this is the ordinary
    // way in rather than an edge: `+ another account` from the signed-out state
    // the panel's own `log out` leaves behind.
    if (status.current) {
      // Captured BEFORE the logout: after it there is nothing left to record,
      // and the account just left is the one most likely to be wanted back.
      this.accounts.capture(status.current);
      try {
        await claude(['auth', 'logout']);
      } catch (err) {
        // Nothing has changed — still signed in, no pane, no pending.
        throw new Error(`could not log out: ${reason(err)}`);
      }
    }

    // From here the human is signed out, and every failure below has to say so.
    const after = status.current === null ? status : await this.status();
    const sawLoggedOut = after?.current === null;

    const pre = email !== null && EMAIL.test(email) ? ` --email ${email}` : '';
    let paneId: string;
    try {
      paneId = await this.herdr.launchCommand(await this.where(), `claude auth login${pre}`);
    } catch (err) {
      throw new Error(
        'you are logged out and the login pane could not be opened — run `claude auth login` '
        + `in a terminal. ${(err as Error).message}`,
      );
    }

    this.pending = {
      email, paneId, from: status.current, sawLoggedOut, since: Date.now(),
    };
    return this.view();
  }

  /**
   * What the human calls this profile. Local to the cockpit and invisible to
   * Claude Code — it renames a row, never an account.
   */
  async label(key: AccountKey, label: string): Promise<AccountView | null> {
    if (!this.accounts.setLabel(key, label)) return null;
    return this.view();
  }

  /** Signs out and stops there. No pane, nothing pending, nothing to finish. */
  async logout(): Promise<AccountView> {
    const status = await this.status();
    if (status?.current) this.accounts.capture(status.current);
    try {
      await claude(['auth', 'logout']);
    } catch (err) {
      throw new Error(`could not log out: ${reason(err)}`);
    }
    return this.view();
  }

  /**
   * Give up on a login that is going nowhere. Closes the pane, which is the one
   * thing the human cannot do from here without going to find the tab.
   */
  async abandon(): Promise<AccountView> {
    const paneId = this.pending?.paneId;
    this.pending = null;
    if (paneId) await this.herdr.closePane(paneId).catch(() => {});
    return this.view();
  }

  private async status(): Promise<{ current: AccountIdentity | null } | null> {
    try {
      return statusOf(await claude(['auth', 'status', '--json']));
    } catch (err) {
      // **`claude auth status --json` EXITS 1 WHEN SIGNED OUT** and prints its
      // JSON anyway — measured: `{"loggedIn":false,...}` on stdout, exit 1. So
      // the rejection has to be parsed too, and reading only the resolved case
      // reported `not on PATH` about a machine that was merely signed out: the
      // one conflation `available` exists to prevent, and it made signing back
      // in from the cockpit impossible from exactly the state `log out` leaves.
      // A failure with no readable stdout still answers null, ENOENT included.
      return statusOf((err as { stdout?: string }).stdout ?? '');
    }
  }

  /**
   * Whether the pending login has landed, and the clean-up if it has.
   *
   * The test is "signed in, and something has changed since we logged out", not
   * "signed in" alone — because it is not established whether `claude auth
   * status` reflects a logout immediately, and a status that lagged would report
   * the login finished the instant it started, closing the pane in the human's
   * face. Either signal is enough: we saw signed-out at some point, or the
   * account is not the one we left. Both failing means the only observable state
   * is the one we started in, and waiting is the honest answer to that.
   */
  private async settle(current: AccountIdentity | null): Promise<void> {
    const p = this.pending;
    if (!p) return;

    if (current === null) {
      p.sawLoggedOut = true;
      return;
    }
    // The ACCOUNT, not the address: switching between two accounts on one
    // address never changes the email, so for that case `sawLoggedOut` is the
    // only one of the two signals that can fire.
    if (!p.sawLoggedOut && p.from !== null && sameAccount(current, p.from)) return;

    this.pending = null;
    this.accounts.capture(current);
    await this.herdr.closePane(p.paneId).catch(() => {
      // The login worked; a tab that outlives it is the human's to close.
    });
  }

  /**
   * Where the login pane goes: our own directory, for `usage.ts`'s reason — it
   * is not a repo, so the pane files its output among nobody's project — and the
   * first space, inheriting that one's weakness of a Herdr with no space at all.
   *
   * `trustFolder` for `usage.ts`'s reason too, and it is cheap insurance rather
   * than a measured need: `auth login` is a subcommand and should never raise
   * Claude Code's workspace-trust dialog. If it did, on a machine where the
   * usage agent has never run, the login would sit at a security question while
   * the cockpit polled for a status that was never going to change.
   */
  private async where(): Promise<{ workspaceId: string; cwd: string; label: string }> {
    const snap = await this.herdr.snapshot();
    const workspace = snap.workspaces[0];
    if (!workspace) throw new Error('herdr has no space to open the login in');

    const cwd = join(homedir(), '.harness');
    mkdirSync(cwd, { recursive: true });
    trustFolder(cwd);
    return { workspaceId: workspace.workspace_id, cwd, label: 'login' };
  }
}
