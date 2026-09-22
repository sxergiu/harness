import { execFileSync } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { STATUS_ORDER, type AgentStatus } from '@harness/shared';

/**
 * Client for the Herdr socket API (protocol 17). Newline-delimited JSON.
 *
 * The protocol shape, established by probing rather than assumed:
 *
 *  - A request connection is ONE-SHOT. You connect, send `{id, method, params}`,
 *    receive one `{id, result}` / `{id, error}`, and the server closes. A second
 *    write on that socket fails with EPIPE. So every request opens its own
 *    connection — there is no multiplexing and no keep-alive to hold.
 *  - `events.subscribe` is the one exception: that connection stays open and
 *    streams `{event, data}` pushes. It sends nothing else, ever.
 *
 * Two naming systems, and they are not the same one:
 *  - subscriptions are DOT-named   ({type: 'pane.updated'})
 *  - pushes arrive UNDERSCORE-named ({event: 'pane_updated'})
 * Subscribing with the push spelling is accepted silently and delivers nothing.
 *
 * ONLY THE NEWEST SUBSCRIBER RECEIVES PUSHES. Measured: subscription A took 9
 * events in 5s, then exactly 0 over the next 8s from the moment B subscribed,
 * while B took 9. A never recovers — not when B disconnects, not ever. The
 * socket stays open and connected and simply goes silent forever.
 *
 * So any other process that subscribes — another agent probing, the Herdr CLI,
 * a second cockpit — permanently kills this one's event feed, and nothing about
 * the connection says so. That is why the board also resyncs on a heartbeat and
 * why `reconnect()` exists: liveness cannot depend on holding the stream.
 */

/**
 * A FLOOR, and deliberately no ceiling.
 *
 * An exact pin was the original design — "refuse rather than misread" — and it
 * is wrong for anything but a single machine. Herdr ships protocol bumps
 * routinely (17 with 0.7.5, 22 with 0.9.0), and an equality test turns every one
 * of them into a cockpit that refuses to start for everybody who installed Herdr
 * more recently than the author. That was the actual state of this file.
 *
 * A ceiling was the first correction and it was also wrong, for a subtler
 * reason: it fired on version DRIFT rather than on anything being broken, so
 * every future Herdr release would raise a banner that meant nothing and a
 * release here to silence it. A warning that cries on a non-event teaches people
 * to ignore warnings, which is the one thing a warning may never do.
 *
 * What the 17 → 22 bump actually cost was measured rather than assumed: every
 * method called, every subscription registered and every parameter sent was
 * diffed against 0.9.0's own bundled schema, and NONE changed.
 * `session.snapshot` is still flat (multi-machine did not nest panes behind a
 * machine), `PaneInfo` still carries `agent_status` and `agent_session`, and
 * `state_change_seq` vanishing costs nothing because no code ever read it. Five
 * protocol versions moved and this surface did not.
 *
 * Herdr documents the contract this now follows: clients "should ignore unknown
 * fields and handle unsupported methods as normal errors", and its own UI
 * degrades a missing method to a disabled action rather than a dead connection.
 * That is already how this behaves — `asStatus` narrows anything unrecognised to
 * `unknown`, every read is a named property so extra fields are ignored by
 * construction, `resync` catches a failed snapshot, and an action route answers
 * 503. So a newer protocol simply runs.
 *
 * Below the floor we still refuse: fields the board needs may genuinely be
 * absent, and misreading is worse than not starting.
 */
export const PROTOCOL_MIN = 17;

const REQUEST_TIMEOUT_MS = 10_000;

/** Kept under REQUEST_TIMEOUT_MS so Herdr answers before our own socket gives up. */
const PROMPT_WAIT_MS = 6_000;

/**
 * A shell sitting at its prompt: zsh, bash, root, and the arrow prompts
 * starship and p10k default to. One definition, because the two readers have to
 * agree — `waitForPrompt` waits for a line like this and `lastOutput` is
 * looking for the one thing that is NOT one.
 */
const SHELL_PROMPT = /[%$#>❯] *$/;

/** How long Herdr may spend detecting a started agent. Observed: ~3s. */
const AGENT_START_MS = 30_000;

/** How long we then wait for that launch to become drivable. Observed: 3.2s. */
const LAUNCH_WAIT_MS = 20_000;

/**
 * Long enough for the prompt box to redraw before we judge whether it emptied.
 * Measured against a stalled paste: the placeholder was on screen within 160ms,
 * and a 42 KB one within 80ms — size does not push this out.
 */
const SUBMIT_CHECK_MS = 500;

/**
 * Whether Claude Code's prompt box still holds ANYTHING — the signature of a
 * prompt that was typed but not submitted. A prompt that went and a prompt
 * Claude queued while working both leave the box empty, so emptiness is the
 * whole question and the text we sent does not come into it.
 *
 * Content-free deliberately. Matching the head of our own text went blind
 * exactly where it was needed most: Claude Code COLLAPSES a paste into
 * `[Pasted text #1 +61 lines]`, which contains none of it. Measured — a
 * 62-line paste typed into the box rendered that placeholder and the head match
 * saw nothing, so a stalled paste read as submitted and sat there until the
 * human sent a second prompt, whose Enter submitted the paste a turn late.
 * That is the "pasting needs sending twice" bug, and it is why this may never
 * go back to comparing content.
 *
 * Only the LAST `❯` line counts. A submitted prompt is echoed into the
 * scrollback as `❯ <text>`, so earlier ones are history rather than the box;
 * testing every `❯` line reports a successful prompt as unsent and earns it a
 * spurious Enter. The input box is always the last one: the command menu a
 * slash command opens beneath it marks its selection by highlight, not by `❯`,
 * so a menu open over half the pane contributes no candidate.
 *
 * A box holding what the HUMAN typed at the terminal also counts, and pressing
 * Enter then submits their text along with ours. That is what Claude Code would
 * do with their next Enter anyway — our text was appended to theirs the moment
 * it was typed — and leaving it unsent is the bug this exists to end.
 */
export function promptBoxHolds(pane: string): boolean {
  const box = pane.split('\n').filter((line) => line.trimStart().startsWith('❯')).pop();
  return box !== undefined && box.replace(/^\s*❯/, '').trim().length > 0;
}

/**
 * Whether typed text reached the pane at all — the question `sendText` presses
 * Enter on, and the reason that Enter is conditional.
 *
 * A SELECTION DIALOG SWALLOWS TEXT WHOLESALE. Measured against a live
 * AskUserQuestion with an option row highlighted, `pane.send_input` of "answer
 * 4 with some words" left the pane byte-identical (md5 equal before and after)
 * — digits included, because only real key presses move that highlight, and
 * text arrives as a paste rather than as keys. The same send with the prompt's
 * own "Type something." row highlighted redrew it to `❯ 3. I like both
 * equally`. So the screen answers this and nothing else does.
 *
 * Content-free for `promptBoxHolds`'s reason: Claude Code collapses a paste
 * into `[Pasted text #1 +61 lines]`, so looking for the words we sent goes
 * blind exactly where it matters. Anything at all changing is the signal, and
 * the pane is quiet while it waits — it is blocked, so nothing else redraws it.
 */
export function paneTookText(before: string, after: string): boolean {
  return before !== after;
}

/** What the `herdr` binary printed, or null if it is not on PATH or did not answer. */
function cli(args: string[]): string | null {
  try {
    return execFileSync('herdr', args, {
      encoding: 'utf8', timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Resolved once and kept: none of the three sources changes under a running process. */
let cachedSocketPath: string | undefined;

/**
 * Where Herdr is listening, in its own documented resolution order — and the
 * reason this is a lookup rather than a constant is Windows, where the endpoint
 * is a NAMED PIPE. A path assembled from `homedir()` is not merely in the wrong
 * place there; it is the wrong kind of thing, and `createConnection` would go on
 * failing against a name no Herdr will ever answer to.
 *
 * So ask the binary. `herdr status server --json` reports the socket it WOULD
 * use whether or not a server is running — measured, a bogus HERDR_SOCKET_PATH
 * came back as `{"status":"not_running", ...,"socket":"/tmp/nope.sock"}` — and it
 * resolves `--session`/`HERDR_SESSION` as well, which this client never knew
 * about and would previously have missed by connecting to the default session's
 * socket instead.
 *
 * The env var is still read first, because Herdr injects it into the panes it
 * manages and it is the override the docs name; the unix default remains the
 * last resort, so a machine with Herdr running but not on PATH behaves exactly
 * as it did before.
 */
function socketPath(): string {
  if (cachedSocketPath === undefined) {
    cachedSocketPath = process.env.HERDR_SOCKET_PATH
      ?? reportedSocket()
      ?? join(homedir(), '.config', 'herdr', 'herdr.sock');
  }
  return cachedSocketPath;
}

function reportedSocket(): string | undefined {
  const out = cli(['status', 'server', '--json']);
  if (out === null) return undefined;
  try {
    const { socket } = JSON.parse(out) as { socket?: unknown };
    return typeof socket === 'string' && socket.length > 0 ? socket : undefined;
  } catch {
    return undefined; // an older CLI, or one that stopped answering in JSON
  }
}

/**
 * What to type when Herdr is missing, which is the one preflight note a person
 * cannot act on if it names the wrong package manager. Upgrading needs no such
 * split: `herdr update` is the binary's own path on every platform.
 */
const INSTALL_HINT = process.platform === 'win32'
  ? 'irm https://herdr.dev/install.ps1 | iex'
  : process.platform === 'darwin'
    ? 'brew install herdr'
    : 'curl -fsSL https://herdr.dev/install.sh | sh';

/** `null` once we have looked and found nothing, so we look exactly once. */
let cachedBinaryVersion: string | null | undefined;

/**
 * The version of the INSTALLED binary, which is not necessarily the version of
 * the running server — see `staleServerWarning`.
 */
function binaryVersion(): string | undefined {
  if (cachedBinaryVersion === undefined) {
    // `herdr --version` prints "herdr 0.9.0".
    cachedBinaryVersion = cli(['--version'])?.split(/\s+/).pop() ?? null;
  }
  return cachedBinaryVersion ?? undefined;
}

/**
 * Upgrading Herdr does NOT upgrade the server that is already running, and
 * nothing anywhere says so. Measured: `herdr --version` reported 0.9.0 while the
 * live server was still 0.7.5 on protocol 17, the cockpit kept working against
 * the old one, and the `herdr` CLI had meanwhile started refusing every command
 * with a protocol mismatch. That state is stable and silent, and it confused the
 * author of this repo on his own machine — so the cockpit now names it.
 *
 * It is a warning rather than a failure because everything still WORKS in that
 * state; what the user loses is their CLI and the upgrade they thought they had.
 */
export function staleServerWarning(binary?: string, server?: string): string | undefined {
  if (!binary || !server || binary === server) return undefined;
  return `Herdr ${binary} is installed but the running server is still ${server} — the upgrade has not taken effect. `
    + 'Finish it with `herdr server stop` then `herdr server`; stopping exits pane processes.';
}

/**
 * Herdr's raw status string, narrowed to the enum. Anything unrecognised is
 * `unknown` rather than a guess — the board and an aside must reach the same
 * verdict about the same string, so there is one of these.
 */
export function asStatus(raw: string | undefined): AgentStatus {
  return (STATUS_ORDER as string[]).includes(raw ?? '') ? (raw as AgentStatus) : 'unknown';
}

const RETRY_MIN_MS = 1_000;

/**
 * Kept near the board's own 3s heartbeat rather than higher. The heartbeat
 * resyncs whether or not the stream is ours, so a Herdr that comes back fills
 * the board in ~3s — and a ceiling far above that would leave the banner saying
 * "disconnected" over a board that was visibly moving, which is two parts of one
 * window disagreeing.
 */
const RETRY_MAX_MS = 10_000;

/** 1s, 2s, 4s, 8s, then 10s forever. */
export function backoffMs(attempt: number): number {
  return Math.min(RETRY_MIN_MS * 2 ** attempt, RETRY_MAX_MS);
}

export interface Connection {
  connected: boolean;
  error?: string;
}

/**
 * Whether a transition is worth telling anyone about.
 *
 * `fail` used to report unconditionally, and a Herdr that is simply not running
 * fails every retry with the same ENOENT — so the cockpit announced an identical
 * disconnect once a second for as long as it was left open. That reached
 * `log.ts`, whose 1 MB cap is not a rotation: past it the file records NOTHING
 * further. Measured at ~104 bytes a line, an outage silenced the log in under
 * three hours — the one artifact a bug report is built from, destroyed by the
 * fault it exists to describe.
 *
 * Suppressing repeats is safe for a viewer that arrives mid-outage because it is
 * not how one is told: `index.ts` re-sends the Herdr state on every WS connect,
 * so a tab opened during an outage hears about it from that and not from a
 * broadcast it was not there for.
 */
export function announces(prev: Connection | null, next: Connection): boolean {
  return prev === null || prev.connected !== next.connected || prev.error !== next.error;
}

export interface PaneInfo {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  /** The agent KIND ("claude"), present whenever a pane hosts one. */
  agent?: string;
  /** A custom Herdr name. Absent until something renames the agent. */
  name?: string;
  agent_status?: string;
  agent_session?: { value: string; kind: 'id' | 'path' };
  terminal_title_stripped?: string;
  focused?: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  label: string | null;
  number: number;
  pane_count: number;
  focused: boolean;
}

/**
 * The custom name lives ONLY here — `panes[]` does not carry it, so the board
 * must join on pane_id to know an agent's real name rather than deriving one.
 */
export interface AgentInfo {
  pane_id: string;
  name?: string;
  /** Only `agent.get` fills these in; the snapshot's `agents[]` carries neither. */
  tab_id?: string;
  cwd?: string;
  agent_status?: string;
  agent_session?: { value: string; kind: 'id' | 'path' };
  launch_pending?: boolean;
}

export interface Snapshot {
  protocol: number;
  version: string;
  workspaces: WorkspaceInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
}

/** Everything that can change the board. Any of them triggers a resync. */
const SUBSCRIPTIONS = [
  'pane.created', 'pane.updated', 'pane.closed', 'pane.exited', 'pane.agent_detected',
  'workspace.created', 'workspace.updated', 'workspace.closed',
  'tab.created', 'tab.closed',
].map((type) => ({ type }));

export class Herdr {
  /** The subscription connection. Nothing else is ever written to it. */
  private stream: Socket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  /** Consecutive failed stream attempts, and so how long the next one waits. */
  private attempt = 0;
  /** The last state anyone was told about — see `announces`. */
  private announced: Connection | null = null;
  private stopped = false;
  connected = false;

  /**
   * A working cockpit with something to disclose — currently only the
   * installed-binary-vs-running-server split. Distinct from the error `fail`
   * reports, which means the board is not live at all.
   *
   * Never set for a merely-newer protocol: that is a non-event (see
   * `PROTOCOL_MIN`), and a banner raised on every Herdr release is a banner
   * nobody reads by the time it matters.
   */
  warning: string | undefined;

  /** What the running server said it was, for preflight and diagnostics. */
  serverVersion: string | undefined;

  /**
   * Everything wrong that a human could act on, in the order they would act.
   * Empty means Herdr is installed, running, and current.
   *
   * Reports rather than refuses. A cockpit that starts without Herdr is useful —
   * the banner says it is down and the board fills in the moment it comes up —
   * whereas one that exits leaves an `npx` user with a dead command and no idea
   * which of three different things went wrong.
   */
  async preflight(): Promise<string[]> {
    const notes: string[] = [];
    const binary = binaryVersion();
    if (!binary) notes.push(`Herdr is not on PATH. Install it with: ${INSTALL_HINT}`);

    try {
      const pong = await this.request<{ protocol: number; version?: string }>('ping');
      // Recorded here as well as on connect, because preflight runs first and a
      // diagnostic that reports `unknown` for the first few hundred ms of every
      // run is worth less than no diagnostic.
      this.serverVersion = pong.version;
      const stale = staleServerWarning(binary, pong.version);
      if (stale) notes.push(stale);
      if (pong.protocol < PROTOCOL_MIN) {
        notes.push(`Herdr speaks protocol ${pong.protocol}; this needs at least ${PROTOCOL_MIN}. Upgrade with: herdr update`);
      }
    } catch {
      notes.push(`No Herdr server is answering on ${socketPath()}. Start one with: herdr server`);
    }
    return notes;
  }

  constructor(
    /** Fired for every push. The board debounces and resyncs; it does not diff pushes. */
    private readonly onPush: (event: string) => void,
    private readonly onConnectionChange: (connected: boolean, error?: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    // Nothing has been said yet, so the first state reached — up or down — is
    // news, and the first retry waits the floor. Without these a restart would
    // inherit the last run's verdict and stay silent about matching it, and
    // inherit its backoff and open at the ceiling.
    this.announced = null;
    this.attempt = 0;
    void this.openStream();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    // Cleared, not merely stopped. `stopped` is what holds `scheduleRetry` off
    // until a `start()` clears it; from then on a stale non-null handle would
    // read as a retry already pending, and none would ever be armed again.
    this.retry = null;
    this.stream?.destroy();
    this.stream = null;
    this.connected = false;
  }

  /**
   * Take the event stream back. The only cure for having been starved by a
   * newer subscriber, and there is no way to detect that from the socket — it
   * stays open and merely stops delivering — so this is driven by the human
   * pressing refresh rather than by anything we can observe.
   *
   * `stream` is cleared BEFORE the destroy so the close handler treats the old
   * socket as stale and skips its disconnect broadcast and its retry; otherwise
   * refreshing would flash "Herdr disconnected" and open a second stream.
   *
   * A pending retry is cancelled for the same reason, and that was missing: an
   * outage always has one armed, so refreshing during one opened a stream here
   * and left the retry to open a SECOND a moment later. Cancelling covers only
   * a retry still ARMED, which is why `openStream` destroys whatever it is
   * replacing rather than trusting this to have emptied the field — between a
   * retry firing and its stream landing there is nothing here to cancel.
   */
  reconnect(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    // A human asking for the stream back is not a backed-off retry: the next
    // failure after this should wait 1s, not wherever the outage had climbed to.
    this.attempt = 0;
    // Pressing refresh is always news. Without this the reclaim is silent —
    // `announced` still says connected, since the destroy below is deliberately
    // stale-by-identity and reports nothing — and silence is indistinguishable
    // from the button having done nothing, on the one control whose whole
    // purpose is curing a starvation that is invisible from the socket.
    this.announced = null;
    const old = this.stream;
    this.stream = null;
    old?.destroy();
    void this.openStream();
  }

  /**
   * The one way a connection state reaches anybody. Everything that reports goes
   * through here so the dedup cannot be bypassed by a new call site.
   */
  private report(next: Connection): void {
    if (!announces(this.announced, next)) return;
    this.announced = next;
    this.onConnectionChange(next.connected, next.error);
  }

  // -- the event stream -----------------------------------------------------

  private async openStream(): Promise<void> {
    const path = socketPath();

    // Version-gate on its own one-shot connection, before committing to a stream.
    // Note this asks the RUNNING SERVER, which is not necessarily the installed
    // binary: upgrading Herdr leaves the old server up until it is restarted, and
    // the two disagree until then.
    try {
      const pong = await this.request<{ protocol: number; version?: string }>('ping');
      if (pong.protocol < PROTOCOL_MIN) {
        this.fail(`Herdr speaks protocol ${pong.protocol}; this harness needs at least ${PROTOCOL_MIN}.`);
        return;
      }
      this.serverVersion = pong.version;
      this.warning = staleServerWarning(binaryVersion(), pong.version);
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }

    const sock = createConnection(path);
    // Exclusive, because cancelling a pending retry cannot be: the timer nulls
    // its own handle and then waits on `ping`, so for up to REQUEST_TIMEOUT_MS
    // both `retry` and `stream` are null and a `reconnect` in that window sees
    // nothing to cancel. Two streams then race, and the one that loses the
    // identity check in `drop` is never destroyed and never retried — a
    // subscribed socket leaked for the life of the process, which by invariant 2
    // may be the one Herdr is feeding. Destroying here settles it whichever
    // order they land in.
    this.stream?.destroy();
    this.stream = sock;
    const decoder = new StringDecoder('utf8');
    let buf = '';

    sock.on('connect', () => {
      sock.write(`${JSON.stringify({ id: 'sub', method: 'events.subscribe', params: { subscriptions: SUBSCRIPTIONS } })}\n`);
    });

    sock.on('data', (chunk) => {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let msg: { event?: unknown; result?: { type?: string } };
        try {
          msg = JSON.parse(line) as typeof msg;
        } catch {
          continue; // a frame we cannot parse is not worth dropping the stream over
        }

        if (typeof msg.event === 'string') {
          this.onPush(msg.event);
        } else if (msg.result?.type === 'subscription_started') {
          this.connected = true;
          this.attempt = 0;
          this.report({ connected: true });
          this.onPush('subscribed');
        }
      }
    });

    const drop = (err?: Error): void => {
      if (this.stream !== sock) return; // a stale socket from a previous attempt
      this.stream = null;
      const wasConnected = this.connected;
      this.connected = false;
      // The guard stays: a socket that closes having never subscribed and
      // without an error says nothing the last `fail` has not already said
      // better, and reporting it would overwrite that message with a blank one.
      if (wasConnected || err) this.report({ connected: false, error: err?.message });
      this.scheduleRetry();
    };

    sock.on('error', (err) => drop(err));
    sock.on('close', () => drop());
  }

  private fail(message: string): void {
    this.connected = false;
    this.report({ connected: false, error: message });
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    // Post-increment, so the first retry after a working connection waits the
    // floor rather than a step up from it.
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.openStream();
    }, backoffMs(this.attempt++));
  }

  // -- one-shot requests ----------------------------------------------------

  /** Opens its own connection, because the server closes after one response. */
  request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    const path = socketPath();

    return new Promise<T>((resolve, reject) => {
      const sock = createConnection(path);
      const decoder = new StringDecoder('utf8');
      let buf = '';
      let settled = false;

      const finish = (err: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(value as T);
      };

      const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out`)), timeoutMs);

      sock.on('connect', () => {
        sock.write(`${JSON.stringify({ id: '1', method, params })}\n`);
      });

      sock.on('data', (chunk) => {
        buf += decoder.write(chunk);
        const nl = buf.indexOf('\n');
        if (nl < 0) return; // response not yet complete

        try {
          const msg = JSON.parse(buf.slice(0, nl)) as { result?: T; error?: unknown };
          if (msg.error) finish(new Error(describeError(msg.error)));
          else finish(null, msg.result as T);
        } catch (err) {
          finish(err as Error);
        }
      });

      sock.on('error', (err) => finish(err));
      sock.on('close', () => finish(new Error(`herdr closed without answering ${method}`)));
    });
  }

  // -- the methods this product actually uses -------------------------------

  async snapshot(): Promise<Snapshot> {
    const r = await this.request<{ snapshot: Snapshot }>('session.snapshot');
    return r.snapshot;
  }

  /**
   * Raw pane text. The only path by which terminal output reaches the browser.
   *
   * Omitting `lines` reads the whole visible region, whatever the viewport is.
   * A count reads only that many lines up from the bottom, so ask for one only
   * when the bottom is where the thing you are looking for lives.
   */
  async read(paneId: string, lines?: number): Promise<string> {
    const r = await this.request<{ read?: { text?: string }; text?: string }>('pane.read', {
      pane_id: paneId, source: 'visible', format: 'text', lines,
    });
    return r.read?.text ?? r.text ?? '';
  }

  /**
   * Submits a prompt, then checks that it actually went.
   *
   * `agent.prompt` types the text and submits it, and the submit does not always
   * land: observed once, the text sat in Claude Code's prompt box unsent until
   * the *next* Enter, which then sent it a turn late. It is not our request —
   * relaying Herdr's socket shows its own CLI sends this identical frame, and
   * there is no submit flag to pass. So this verifies rather than assumes.
   *
   * The nudge never fires blind: it presses Enter only when the prompt box is
   * still holding something. A prompt that submitted normally, or one Claude
   * queued while working (the box goes empty either way), costs one pane read
   * and nothing else.
   */
  async prompt(target: string, text: string): Promise<unknown> {
    const result = await this.request('agent.prompt', { target, text });
    try {
      await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
      // The WHOLE visible pane, never a tail of it. A slash command opens Claude
      // Code's command menu UNDER the box, and the menu is tens of rows tall:
      // measured, a 14-line window held nothing but menu, so the check saw no
      // `❯` line at all, read that as submitted, and left `/exit` sitting in the
      // box until the human sent it a second time.
      if (promptBoxHolds(await this.read(target))) {
        await this.sendKeys(target, ['enter']);
      }
    } catch { /* the check is a safety net; never fail a sent prompt over it */ }
    return result;
  }

  sendKeys(target: string, keys: string[]): Promise<unknown> {
    return this.request('agent.send_keys', { target, keys });
  }

  /**
   * Types an answer into the pane and submits it, for the prompts that ask for
   * words rather than a number — "tell Claude what to do differently" and the
   * like. Pane-level on purpose: `agent.*` refuses a target that is sitting at
   * a dialog, and this is answering the terminal, not prompting the agent.
   *
   * THE ENTER IS CONDITIONAL, and that is the whole of this function. It used
   * to ride along in the one `send_input` call, which is fine at a shell and
   * puts words in the human's mouth at a dialog: measured on a live
   * AskUserQuestion, typing a custom answer changed nothing on screen
   * (`paneTookText`) and the trailing Enter committed whichever row happened to
   * be highlighted — the agent recorded "→ Spaces" as the human's answer while
   * what they actually wrote was discarded unseen. Sending it blind is not the
   * optimism this path is built on; optimism is a keystroke you can see the
   * result of, and this was a false answer attributed to someone.
   *
   * So: type, look, and only then submit. One extra read, inside the window
   * `prompt` already waits — measured, a row that accepts the text redraws in
   * 37ms against the 500ms allowed.
   *
   * REFUSING IS THE ANSWER, not a shortfall. Driving the human's words into a
   * dialog means finding the row that takes words, which means parsing the
   * prompt — the one thing this path does not do (see `BLOCKED_KEYS`). The
   * caller is told instead, and the human highlights the row and sends again.
   *
   * This is also what makes `launchCommand`'s "the command was never typed"
   * real rather than assumed: it had only the absence of a thrown request,
   * which a swallowed command does not produce.
   */
  async sendText(paneId: string, text: string): Promise<unknown> {
    const before = await this.read(paneId);
    const result = await this.request('pane.send_input', { pane_id: paneId, text });

    await new Promise((r) => setTimeout(r, SUBMIT_CHECK_MS));
    if (!paneTookText(before, await this.read(paneId))) {
      throw new Error(
        'the pane ignored those words — a dialog like this takes keys, not text. '
        + 'Highlight the row that asks for text (↑/↓), then send them again.',
      );
    }

    await this.request('pane.send_input', { pane_id: paneId, keys: ['enter'] });
    return result;
  }

  focus(target: string): Promise<unknown> {
    return this.request('agent.focus', { target });
  }

  rename(target: string, name: string): Promise<unknown> {
    return this.request('agent.rename', { target, name });
  }

  /**
   * One agent by name, or null when Herdr has none. Richer than the snapshot's
   * `agents[]`, which carries only a pane id and a name: this answers with the
   * pane, the tab, the cwd, the status and the session in one small request, so
   * an agent kept by name needs no snapshot to be found again.
   *
   * Only `agent_not_found` reads as null. A socket failure must throw, because
   * a caller that starts an agent when none is found would otherwise start a
   * second one under the same name every time Herdr hiccuped. Matched on the
   * message: `request` flattens Herdr's `{code, message}` to the message alone.
   */
  async agentInfo(name: string): Promise<AgentInfo | null> {
    try {
      const r = await this.request<{ agent?: AgentInfo }>('agent.get', { target: name });
      return r.agent ?? null;
    } catch (err) {
      if (/not found/i.test((err as Error).message)) return null;
      throw err;
    }
  }

  /**
   * A fresh tab with an agent running in it, or nothing at all. One of the two
   * places a tab is created, and both are here: see `launchCommand` for what
   * they each guarantee and why they cannot be one function.
   *
   * The sequence is four steps and every one of them is load-bearing (invariants
   * 12 and 13): the tab, the shell reaching its prompt before `agent.start`
   * types into it, the start, and the wait for the launch to become drivable.
   * Together ~4s, which is why the buttons in front of it say so.
   *
   * The fourth step is also the only one that can tell whether any of it
   * worked: `agent.start` answers ok in ~107ms either way, because it has only
   * typed a command at a shell. A `claude` that then prints an error and exits
   * left a pane NOTHING could find again — no agent, so no board row, and
   * `agent.get` answers `agent_not_found` — which the live session had one of,
   * a bare shell reading "No conversation found with session ID" where an aside
   * had been forked off a conversation that was already cleared. Whatever this
   * creates and cannot start, it closes, and closing the pane takes the tab
   * with it, `tab.create` having handed back only the pane id.
   */
  async launchAgent(
    name: string,
    where: { workspaceId: string; cwd: string; label: string },
    args: string[],
  ): Promise<string> {
    const r = await this.request<{ root_pane: { pane_id: string } }>('tab.create', {
      workspace_id: where.workspaceId, cwd: where.cwd, focus: false, label: where.label,
    });
    const paneId = r.root_pane.pane_id;

    try {
      await this.waitForPrompt(paneId);
      await this.startAgent(name, paneId, args);
      if (!(await this.waitForLaunch(name))) {
        const why = await this.lastOutput(paneId);
        throw new Error(`${name} exited as soon as it started${why ? `: ${why}` : ''}`);
      }
    } catch (err) {
      await this.closePane(paneId).catch(() => {});
      throw err;
    }
    return paneId;
  }

  /**
   * A fresh tab with a shell command typed into it, for the one thing the
   * cockpit needs that is not an agent: `claude auth login`, which opens a
   * browser and has to be visible while the human finishes it.
   *
   * There is no Herdr method that runs a command in a pane. Measured against
   * protocol 22: `tab.create` takes `cwd`, `env`, `focus`, `label` and
   * `workspace_id` and no argv, and there is no `pane.run` or `pane.exec`
   * anywhere in the schema — so typing at a shell is the only path, which makes
   * `waitForPrompt` (invariant 12) as load-bearing here as in `launchAgent`.
   * It must be `pane.send_input`: `pane.send_text` exists and takes NO keys, so
   * reaching for it types the command and never submits it, and a login sitting
   * unsubmitted looks exactly like a human being slow — invariant 14's failure
   * at a different call site.
   *
   * This and `launchAgent` own DIFFERENT failures, which is why one function
   * with a flag would be worse than two. `launchAgent` owns "the agent never
   * started", which only `agent.get` can answer. This owns "the command was
   * never typed" — `tab.create` succeeded and `pane.send_input` did not — and
   * closes the pane, so neither can leave behind the bare shell of invariant 19.
   * It deliberately does NOT own "the command failed", for invariant 12's
   * reason: it has only typed at a shell and cannot know what that did. For its
   * one caller that is right twice over, because a pane where the login went
   * wrong is precisely what the human is being shown.
   */
  async launchCommand(
    where: { workspaceId: string; cwd: string; label: string },
    command: string,
  ): Promise<string> {
    const r = await this.request<{ root_pane: { pane_id: string } }>('tab.create', {
      workspace_id: where.workspaceId, cwd: where.cwd, focus: true, label: where.label,
    });
    const paneId = r.root_pane.pane_id;

    try {
      await this.waitForPrompt(paneId);
      await this.sendText(paneId, command);
    } catch (err) {
      await this.closePane(paneId).catch(() => {});
      throw err;
    }
    return paneId;
  }

  /** Closes a pane, and with it the tab when it was the tab's only one. */
  closePane(paneId: string): Promise<unknown> {
    return this.request('pane.close', { pane_id: paneId });
  }

  /**
   * Waits for a fresh pane's shell to reach its prompt.
   *
   * `tab.create` returns while the shell is still sourcing rc files, and
   * `agent.start` starts an agent by TYPING the command — so without this the
   * keystrokes are swallowed and the pane sits at a prompt with a mangled line,
   * while `agent.start` still answers `ok`. Observed: the prompt lands ~0.5s
   * later. Herdr can watch for it, so it does the waiting rather than us.
   *
   * Best-effort: an unrecognised prompt must not make starting impossible, so a
   * timeout proceeds anyway. By then the shell has had 6s.
   */
  private async waitForPrompt(paneId: string): Promise<void> {
    try {
      await this.request('pane.wait_for_output', {
        pane_id: paneId,
        source: 'visible',
        match: { type: 'regex', value: SHELL_PROMPT.source },
        timeout_ms: PROMPT_WAIT_MS,
      });
    } catch { /* an exotic prompt is not a reason to refuse to start */ }
  }

  /**
   * Note there is no cwd here — it comes from the pane, which is why the space
   * owns one.
   *
   * This RETURNS BEFORE THE AGENT IS USABLE. It answers in ~100ms with
   * `launch_pending: true`, and until that clears (~3s) Herdr refuses to prompt
   * or rename the agent — `agent.prompt` says "not an active named agent" and
   * `agent.rename` says "startup is pending", even though the agent is visibly
   * running. `timeout_ms` does not change this; it bounds Herdr's own detection.
   * Callers that hand the agent straight to a human must `waitForLaunch` after.
   *
   * Its `ok` says the command was TYPED, and nothing more. Measured twice at
   * 106–107ms — the same answer for a launch that worked and for a `--resume`
   * of a session that was gone, where `claude` printed "No conversation found"
   * and exited. So it cannot be asked whether an agent is running; only
   * `waitForLaunch` can answer that.
   */
  private startAgent(name: string, paneId: string, args: string[]): Promise<unknown> {
    return this.request('agent.start', {
      name, kind: 'claude', pane_id: paneId, args, timeout_ms: AGENT_START_MS,
    });
  }

  /**
   * Polls until a started agent is drivable, which is how Herdr's own CLI ends
   * `agent start` — there is no push and no blocking call to wait on. Observed:
   * 3.2s, with or without our args.
   *
   * It also answers the question `agent.start` cannot: whether there is an
   * agent there AT ALL. A launch that dies is registered first and dropped
   * after — measured on a doomed `--resume`, `agent.get` found it
   * `launch_pending` at +211ms through +1320ms and answered `agent_not_found`
   * from +1726ms on, while a real one was still pending past +2640ms. So
   * `null` and `launch_pending` are opposite answers, and reading them as one
   * (`!info?.launch_pending`) is how a start that never happened returned a
   * pane id and left a bare shell behind.
   *
   * UNCERTAINTY ANSWERS TRUE, because `launchAgent` closes the pane on a false:
   * a Herdr that stops answering, or a launch still pending after 20s, is a
   * slow or unreachable agent rather than a dead one, and closing the pane on
   * that guess would end an agent that is running.
   */
  private async waitForLaunch(name: string): Promise<boolean> {
    const deadline = Date.now() + LAUNCH_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      let info: AgentInfo | null;
      try {
        info = await this.agentInfo(name);
      } catch {
        return true; // Herdr is down or hiccuping; the resync will tell the truth
      }
      if (info === null) return false;
      if (!info.launch_pending) return true;
    }
    return true;
  }

  /**
   * What a pane printed last, ignoring the shell prompt it returned to.
   *
   * Closing a failed launch takes the account of what went wrong off the screen
   * with it — the bare shell left by the old behaviour at least still read "No
   * conversation found with session ID", which is the whole diagnosis. So the
   * reason travels out in the error instead of dying with the pane.
   */
  private async lastOutput(paneId: string): Promise<string | undefined> {
    const text = await this.read(paneId, 8).catch(() => '');
    return text
      .split('\n')
      .filter((line) => line.trim() && !SHELL_PROMPT.test(line))
      .pop()
      ?.trim()
      .slice(0, 200);
  }

  toast(title: string, body: string, urgent: boolean): Promise<unknown> {
    return this.request('notification.show', {
      title, body, sound: urgent ? 'request' : 'done', position: 'top-right',
    });
  }
}

function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
    return JSON.stringify(err);
  }
  return 'herdr error';
}
