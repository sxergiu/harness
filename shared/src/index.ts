/** Types shared between server and web. Import via `@harness/shared`. */

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/** Herdr's own enum, verbatim. `done` is idle-after-unseen-work. */
export type AgentStatus = 'blocked' | 'done' | 'working' | 'idle' | 'unknown';

/** Attention order. Every agent not locked to a position is kept in it. */
export const STATUS_ORDER: AgentStatus[] = ['blocked', 'done', 'working', 'idle', 'unknown'];

/**
 * A row's hand-set tint, and the order right-clicking cycles through them in —
 * the queue IS this array, so the last one steps back to no shade at all.
 *
 * Distinct hues rather than steps of one brightness: the whole job is telling
 * rows apart at a glance, and a luminance ladder over a near-black page cannot
 * carry more than about three steps before they stop reading as different. The
 * server never interprets these names; it stores whichever one you picked.
 *
 * Amber and red are deliberately absent. They are the loudest colours in the
 * column already — blocked status, every warning, error text, the usage bars —
 * and a row washed in one would read as a claim about the agent, which is the
 * one thing a shade must never do.
 */
export const AGENT_SHADES = ['indigo', 'teal', 'lime', 'rose', 'purple'] as const;
export type AgentShade = typeof AGENT_SHADES[number];

export interface WorkspaceRow {
  id: string;
  /** Herdr's workspace label, usually the repo name. */
  label: string | null;
  number: number;
  agentCount: number;
  focused: boolean;
  /**
   * Where agents started in this space run. Herdr has no such field — it is
   * read off the space's own panes and overridable by hand, which is why an
   * agent needs no directory of its own.
   */
  dir: string | null;
  /**
   * Whether agents started here are told they may commit and push. A fact about
   * the CHECKOUT, so every space on one path carries the same answer, and
   * derived from the path-keyed store on each resync rather than held on the
   * row — a workspace id is Herdr's and is recycled, a path is not.
   */
  gitDelegated: boolean;
}

/**
 * Context held by an agent's last request. `tokens` is exact — Claude Code
 * records the usage of every request. `window` is not recorded anywhere and is
 * inferred, so treat the share as close rather than authoritative.
 */
export interface ContextUse {
  tokens: number;
  window: number;
}

/**
 * One row of the board. Assembled from two sources: Herdr owns identity and
 * status, the agent's own transcript owns what it is actually doing.
 */
export interface AgentRow {
  paneId: string;
  workspaceId: string;
  tabId: string;
  /** Herdr agent name, or a slug we derived from the terminal title. */
  name: string;
  status: AgentStatus;
  cwd: string;
  /** basename(cwd) — what you actually recognise a row by. */
  repo: string;
  /** agent_session.value. Changes on /clear, so it is never cached by pane. */
  sessionUuid: string | null;
  /** Null is a normal state: the transcript may be pruned or not yet written. */
  transcriptPath: string | null;
  /**
   * When the current status began, stamped by us. Herdr only exposes a counter,
   * so this is unknown until the first transition after a harness restart.
   */
  stateSince: string | null;
  title: string | null;
  /** Newest tool call, humanised: "edit src/catalogue/mapper.ts". */
  activity: string | null;
  /** The in_progress item of the latest TodoWrite, when the agent keeps one. */
  todo: string | null;
  /**
   * An active `/goal` — the condition Claude is working toward unprompted.
   * Read from an internal, version-unstable transcript field, so treat its
   * absence as normal rather than as an error.
   */
  goal: { condition: string; met: boolean } | null;
  /**
   * The one thing this session was set going on — the newest `/feature` or
   * `/investigate`, whichever came last. Neither has a completion signal to
   * read, so this names the work rather than saying it is still in flight.
   * An `investigate` session is one whose output is meant to be the talk, so
   * files written under it are a departure rather than progress.
   */
  assignment: {
    kind: 'feature' | 'investigate';
    text: string;
    /**
     * Files this agent has written since the assignment was set — not since the
     * session began, which would charge an investigation with the writes of the
     * feature it replaced. It is what makes a breach of an investigation
     * visible, and it inherits `fileCount`'s blind spots.
     */
    filesSince: number;
  } | null;
  /**
   * An API error the agent is currently stuck on — "API Error: …", a session
   * limit, an expired login. Null once it produces real work again: Claude Code
   * retries transient failures on its own, so only the tail of the transcript
   * says anything about now.
   */
  error: string | null;
  /**
   * How much of the context window this session is holding, measured from the
   * last request its transcript recorded. Null until the agent has made one —
   * a fresh session and a pruned transcript both look like that.
   */
  context: ContextUse | null;
  fileCount: number;
  /** Names of other live agents that have written a file this one also wrote. */
  contendedWith: string[];
  /**
   * This agent's fork (`aside.ts`), as the pane running it reports — a Herdr
   * status and nothing else. The fork's transcript is never read for this: it
   * is a copy of this agent's own, and reading it would hand the fork this
   * agent's changelist (invariant 18).
   *
   * `cleared` is the trace of a fork that is gone, dropped by hand or reaped
   * when `/clear` discarded the conversation it was forked from. Null means
   * there has never been one — which after a harness restart also covers a fork
   * closed before it, since the observation lived in memory only.
   */
  aside: AgentStatus | 'cleared' | null;
  /**
   * A tint set by hand, for telling apart rows Herdr gives you nothing to tell
   * apart by. It means nothing — that is the point: every other colour on the
   * row is a claim about the agent, and this one is only a claim about you.
   *
   * Held in memory against a pane id, so it is gone after a harness restart and
   * never reaches the RECENT cache on disk (see `Board.agents`).
   */
  shade: AgentShade | null;
  /**
   * Held at a position in its space rather than sorted by attention. Only the
   * fact travels, not the slot: the server has already placed the row, and an
   * index on the wire would be a second opinion about order for the browser to
   * disagree with.
   *
   * Everything unlocked keeps the attention sort among itself and simply flows
   * around whatever is locked. Held in memory against a pane id, like `shade`.
   */
  locked: boolean;
  /** False once the pane is gone: the row moved to RECENT. */
  live: boolean;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/**
 * One rendered entry. Tool and subagent entries carry a one-line summary plus
 * an optional detail the UI reveals on click — never both inline.
 */
export type FeedEntry =
  | { kind: 'user'; text: string }
  /** A slash command the human ran — /clear, /goal, /exit and the rest. */
  | { kind: 'command'; name: string; args: string }
  /** Claude Code's own plumbing (command output, goal checks), not a human turn. */
  | { kind: 'system'; text: string }
  | { kind: 'text'; text: string }
  /** A failed request Claude Code recorded in place of a response. */
  | { kind: 'error'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool';
      name: string;
      /** The primary argument, already shortened for display. */
      summary: string;
      detail: string | null;
      /** Absent while the call is still pending — that is what "blocked" looks like. */
      ok: boolean | null;
      /**
       * The SQL this call ran, in full and unrewritten, so it can be copied and
       * re-run. `summary` above is clipped to 80 characters and cannot serve.
       */
      sql: string | null;
      /**
       * The file this call's `summary` IS, relative to the cwd — carried
       * separately because `summary` is a string and loses the fact that it
       * names a file. Null unless the primary argument was a path inside the
       * cwd, so the browser is never offered a link the file route would refuse.
       */
      path: string | null;
    }
  | {
      kind: 'agent';
      agentType: string;
      description: string;
      /** Rendered from the parent's toolUseResult, so the collapsed line costs no file read. */
      durationMs: number | null;
      toolUseCount: number | null;
      /** Resolved lazily when expanded; the subagent transcript is large. */
      agentId: string | null;
    };

export interface FeedTurn {
  /** 0-based, oldest first. */
  index: number;
  startedAt: string | null;
  entries: FeedEntry[];
}

export interface FeedPage {
  turn: FeedTurn | null;
  totalTurns: number;
}

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/**
 * Derived, never reported: Claude Code writes no subagent status anywhere.
 * `finished` is the only verified one — the parent recorded a result for it.
 * The other three read the PARENT's Herdr status, because a subagent has no
 * pane of its own and its permission prompts appear on the parent's.
 */
export type SubagentStatus = 'running' | 'waiting' | 'finished' | 'stopped';

/**
 * One subagent of one agent, joined from its own transcript and the parent's
 * record of it. Listed from the subagents directory rather than from the
 * parent's tool calls: the parent only records a subagent once it FINISHES, so
 * anything driven off its tool results is blind to the one you want to watch.
 */
export interface SubagentRow {
  agentId: string;
  /** `attributionAgent` from its own transcript — "Plan", "Explore", … */
  agentType: string;
  /** The prompt it was handed, clipped to a line. */
  description: string;
  status: SubagentStatus;
  /** Newest tool call, humanised. Same derivation as the board's activity. */
  activity: string | null;
  /** What it returned to the parent. Null until the parent records a result. */
  output: string | null;
  /** The parent's own measurement once finished, else first→last entry. */
  durationMs: number | null;
  toolUseCount: number;
  startedAt: string | null;
  updatedAt: string | null;
}

export interface SubagentsView {
  subagents: SubagentRow[];
}

// ---------------------------------------------------------------------------
// Aside
// ---------------------------------------------------------------------------

/**
 * A side conversation forked off an agent's session with `--fork-session`, so a
 * question about what you are reading never moves that agent's feed forward.
 *
 * The fork's transcript carries the parent's whole conversation rewritten under
 * a new session id, and the copied entries keep their original uuids — so the
 * exchange that is actually the aside's is the entries the parent has never
 * seen. Everything here is derived from that filter, which is also what keeps
 * the parent's `toolUseResult` hunks from being read as the aside's work.
 */
export interface AsideView {
  /** The forked agent's pane, or null when no aside is open for this agent. */
  paneId: string | null;
  /**
   * The fork's own Herdr status. The board excludes asides, so no `agents`
   * event carries it and this is the only path by which it reaches the browser.
   */
  status: AgentStatus | null;
  /** Only the exchange since the fork; the inherited conversation is dropped. */
  entries: FeedEntry[];
  /**
   * Files the aside has written itself. It is told to change nothing and
   * nothing enforces that, so the count is how a breach becomes visible — and
   * it inherits `AgentRow.fileCount`'s blind spots.
   */
  filesWritten: number;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the pre-edit file, absent on additions. */
  oldLine?: number;
  /** 1-based line number in the current file, absent on deletions. */
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  /**
   * The file no longer contains what this hunk did — another agent overwrote
   * it, or it was reverted. The hunk is still reported, because losing it would
   * hide that the work was clobbered.
   */
  stale?: boolean;
}

export interface DiffFile {
  /** Absolute path as the agent touched it. */
  path: string;
  /** Relative to the project root, for display. */
  relPath: string;
  kind: 'create' | 'update' | 'missing';
  /** Highlight.js language id, best-effort from the extension. */
  language: string | null;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  /** Set when the file was too large to diff, with the reason. */
  note?: string;
  /** Other live agents that also wrote this path. */
  contendedWith?: string[];
}

export interface AgentDiff {
  files: DiffFile[];
}

/**
 * One file as it sits on disk NOW — deliberately not the changelist above it.
 * The hunks are this agent's own work; the file may also hold another agent's
 * later edits, or have been overwritten entirely. Copying is the one place a
 * reviewer wants disk state rather than provenance, and so is reading a file the
 * agent merely referenced, which is the other thing this answers.
 */
export interface FileContent {
  /** Absolute, as RESOLVED — not the string the caller asked for. */
  path: string;
  /** Relative to the agent's cwd, for a heading narrow enough to read. */
  relPath: string;
  /** Highlight.js language id, from the same table `DiffFile.language` uses. */
  language: string | null;
  content: string;
}

// ---------------------------------------------------------------------------
// Blocked
// ---------------------------------------------------------------------------

/**
 * The one place raw terminal text surfaces. We do not parse permission prompts,
 * so a blocked agent shows Herdr's pane output verbatim and the human picks a key.
 */
export interface BlockedView {
  paneId: string;
  text: string;
}

/** One limit bar of the `/usage` panel: what it measures, how full, when it resets. */
export interface UsageLimit {
  /** "session" or "week", from the panel's own heading. */
  label: string;
  percent: number;
  /** "3:20am (Europe/Bucharest)" — verbatim, because it is already a sentence. */
  resets: string | null;
}

/**
 * The `/usage` panel, read off a screen. It is a terminal dialog that writes
 * nothing to the transcript, so something has to run it in a pane and look —
 * which the server does in an agent of its own, never in one doing work.
 *
 * Two limits are the whole answer — how close this account is to its session
 * cap and its weekly one. The panel's other forty lines (cost breakdowns,
 * per-skill shares, advice) are read once and never again, so they do not come
 * across. `text` is the cropped panel, kept only for the case where the dialog's
 * shape moves and nothing parses: showing it raw beats showing nothing.
 */
export interface UsageView {
  limits: UsageLimit[];
  text: string;
}

/**
 * Who Claude Code is signed in as, as `claude auth status --json` reports it.
 *
 * **THE ACCOUNT IS `email` AND `orgId` TOGETHER, never the email alone.** One
 * address can hold two accounts with two subscriptions — a personal Pro and a
 * seat in an organization are the ordinary case — and keying the known list on
 * the email made the second one overwrite the first, so the list stayed at one
 * row and a second account could not be added at all. `orgId` is the only field
 * that tells them apart; `orgName` is what tells them apart on SCREEN, so a row
 * renders it beside the address rather than hiding it in a tooltip.
 *
 * `email` is still all that `claude auth login --email <x>` can be given, which
 * means a switch between two accounts on one address pre-fills the page and
 * leaves the choice of organization to the browser. There is no CLI flag for it.
 */
export interface AccountIdentity {
  email: string;
  /** The disambiguator. Null only from a `claude` that stopped reporting it. */
  orgId: string | null;
  orgName: string | null;
  /** "pro", "max". */
  subscriptionType: string | null;
}

/**
 * Same address AND same organization. Anything less merges two accounts into
 * one. Takes only the two fields it compares, so the pair can be addressed on
 * its own — which is what a rename is sent as.
 */
export type AccountKey = Pick<AccountIdentity, 'email' | 'orgId'>;
export const sameAccount = (a: AccountKey, b: AccountKey): boolean =>
  a.email === b.email && a.orgId === b.orgId;

/**
 * An account the cockpit has seen, under whatever the human calls it.
 *
 * `label` is the ONE field here that Claude Code knows nothing about — every
 * other one is read back off `claude auth status`, and this one is typed into
 * the panel. Null means nobody has renamed it and the address stands in, so an
 * account is identified by what it was signed in with until it is worth calling
 * something else. Clearing the box restores that rather than storing a blank.
 *
 * It exists because the address is not always enough to tell two rows apart:
 * two accounts at one address are the ordinary case, `orgName` is null on at
 * least one real account, and two plans can repeat. `label` is the only
 * disambiguator that is guaranteed to work, because a human chose it.
 */
export interface KnownAccount extends AccountIdentity {
  label: string | null;
}

/**
 * The account surface at the foot of the board: who is live, who else the
 * cockpit has seen, and whether a login is half-finished in a pane.
 *
 * `available: false` is NOT the same as `current: null`, and conflating them
 * reports "logged out" about a machine that is signed in: the first means
 * `claude auth status` never answered — not on PATH, or a version whose output
 * this cannot read — and the second means it answered that nobody is.
 *
 * `known` is ordered most recently signed-in first, by construction. The order
 * IS the recency and no timestamp rides along, the same reasoning that keeps a
 * locked row's slot off the wire: a second opinion about order is something for
 * the browser to disagree with.
 */
export interface AccountView {
  available: boolean;
  /**
   * Carries the stored `label` as well, resolved by the server against the
   * known list — so the line at the foot of the board names the live profile
   * without the browser holding a second opinion about which row it is.
   */
  current: KnownAccount | null;
  known: KnownAccount[];
  /**
   * A `claude auth login` typed into a visible pane and not yet finished. While
   * this is set the human is signed OUT, which is why the panel says so rather
   * than showing an empty account line. `email` is whatever the login page was
   * asked to pre-fill, and null for a plain login.
   */
  pending: { email: string | null; stalled: boolean } | null;
}

/**
 * Everything about this INSTALL, as against the session: what the agents are
 * told, which checkouts they may push from, and whether the files they depend
 * on are actually on the machine.
 *
 * One shape and one read. Four panels each fetching their own would be four
 * round trips for a screen that is opened rarely and never while anything is
 * moving.
 */
/**
 * One of the files the cockpit depends on and cannot carry into an agent — the
 * `planner` subagent, the two commands. `differs` is the interesting state: the
 * human has their own version, and installing over it would be a silent
 * overwrite of their file.
 */
export interface ClaudeFileState {
  /** As Claude Code refers to it: `agents/planner.md`. */
  name: string;
  path: string;
  /** `unavailable` is a build with no assets beside it, not a fact about their file. */
  status: 'missing' | 'ours' | 'differs' | 'unavailable';
}

/**
 * Herdr's blocked-detection manifest. A local one shadows Herdr's own updates
 * entirely, so `version` against `remoteVersion` is how far behind that shadow
 * has fallen — not a cosmetic difference, since what it holds back are
 * detection fixes.
 */
export interface HerdrRuleState {
  path: string;
  installed: boolean;
  /** False for an override the human wrote, which is never regenerated over. */
  ours: boolean;
  /** The remote version this override was built from, per its own `version` field. */
  version: string | null;
  remoteVersion: string | null;
  stale: boolean;
}

export interface SettingsView {
  rules: {
    text: string;
    /** False once the human has written their own — the reset has something to undo. */
    isDefault: boolean;
  };
  /** Only the checkouts git has been delegated in — a revoke removes the entry. */
  checkouts: Array<{ path: string; gitDelegated: boolean }>;
  claudeFiles: ClaudeFileState[];
  herdr: HerdrRuleState;
}

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

export type ServerEvent =
  | {
      type: 'hello';
      workspaces: WorkspaceRow[];
      agents: AgentRow[];
      recent: AgentRow[];
      herdrConnected: boolean;
    }
  /**
   * Whole-list replace, and the only thing that says "something moved". The
   * board is small, it re-sorts on every change anyway, and open feed and diff
   * views refetch off this — there is deliberately no per-agent update event to
   * go stale against it.
   */
  | { type: 'agents'; agents: AgentRow[]; workspaces: WorkspaceRow[] }
  | { type: 'recent'; recent: AgentRow[] }
  /**
   * `error` is why the board is not live; `warning` is a live board saying what
   * it is talking to. They are separate because they render differently and can
   * never both apply.
   */
  | { type: 'herdr'; connected: boolean; error?: string; warning?: string }
  /**
   * The cockpit is closing on purpose. Without this the socket dropping is
   * indistinguishable from a crash, and every open tab settles into "retrying"
   * against a process that is never coming back.
   */
  | { type: 'quit' };

export type ClientEvent = { type: 'ping' };

export const WS_PATH = '/ws';

/**
 * "HERD" on a phone keypad, and chosen mainly for what it is NOT: 4317 and 4318
 * are the OpenTelemetry OTLP gRPC and HTTP defaults, which this used to sit on
 * squarely. That is invisible on a machine running no collector and an instant
 * collision on one that is — Jaeger, Alloy and SigNoz all bind them too — so it
 * only ever showed up on someone else's machine. Unregistered in /etc/services
 * and not a port any common dev tool claims.
 */
export const DEFAULT_PORT = 4373;

/**
 * Where the PAGE is during development, which is not where the API is: Vite
 * serves it and proxies `/api` and `/ws` back to `DEFAULT_PORT`. Built, there is
 * no such split — one process serves both off one port.
 *
 * Here rather than in `vite.config.ts` alone because the server has to name it:
 * a second invocation of a dev cockpit used to open a browser onto the API port,
 * where `GET /` is a JSON 404, once per invocation. Pointing someone at the
 * wrong port is worse than not pointing at all, so the number has one home.
 */
export const DEV_PAGE_PORT = 4374;

/** Bound explicitly: there is no auth, so this must never be 0.0.0.0. */
export const BIND_HOST = '127.0.0.1';
