import { basename } from 'node:path';
import {
  STATUS_ORDER, type AgentRow, type AgentShade, type AgentStatus, type WorkspaceRow,
} from '@harness/shared';
import { ASIDE_PREFIX, asideName } from './aside.js';
import { touchedPaths } from './diff.js';
import { asStatus, type Herdr, type PaneInfo } from './herdr.js';
import type { History } from './history.js';
import { notify } from './notify.js';
import type { Projects } from './projects.js';
import {
  Transcripts, activityOf, assignmentOf, contextOf, errorOf, goalOf, todoOf, transcriptPathFor, type Entry,
} from './transcript.js';
import { USAGE_AGENT } from './usage.js';

/**
 * The join. Herdr owns identity and status; the transcripts own content. Rather
 * than maintain incremental state from pushes, any push triggers a debounced
 * full resync from `session.snapshot` — the session is a handful of panes, and
 * one code path that always produces the whole truth beats a dozen that each
 * produce part of it.
 */

const DEBOUNCE_MS = 120;

/**
 * The board also resyncs on its own, because the push stream cannot be trusted
 * to still be ours: Herdr delivers pushes only to the NEWEST subscriber, so
 * anything else that subscribes silently and permanently starves us while the
 * socket stays open and connected (see `herdr.ts`). Without this the board
 * simply freezes on whatever it last knew, which reads as agents stuck in a
 * state they left minutes ago.
 *
 * It is the same code path as a push — schedule, debounce, one snapshot — so
 * this only bounds staleness; it does not add a second way for rows to change.
 * A snapshot is ~110ms and 16KB, and transcripts are tailed incrementally.
 */
const HEARTBEAT_MS = 3000;

/** Herdr's default title. Naming an agent after it would tell you nothing. */
const GENERIC_TITLE = /^claude code$/i;

export class Board {
  private rows = new Map<string, AgentRow>();
  private workspaces: WorkspaceRow[] = [];
  private transcripts = new Transcripts();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * paneId → the name WE last set. Anything else on a pane was named by the
   * human, and is never overwritten.
   */
  private namedAs = new Map<string, string>();
  private started = false;
  /**
   * Hand-set space directories. Deliberately not persisted: a workspace id only
   * means anything inside one Herdr session, and Herdr recycles them — a dir
   * remembered across restarts could start an agent in the wrong repo. Without
   * an override the dir is read back off the space's panes.
   */
  private dirs = new Map<string, string>();
  /**
   * Parents we have ever seen a fork on, so one that is gone leaves a trace
   * rather than nothing: "had a fork, dropped it" and "never had one" are
   * different facts about an agent. Not persisted, and legitimately empty after
   * a restart in the same way `stateSince` is unknown after one.
   */
  private forked = new Set<string>();
  /**
   * paneId → the slot it is held at within its own space. The lock is on the
   * AGENT, so locking one says nothing about the others: they keep the attention
   * sort among themselves and flow around it.
   *
   * A slot rather than a sequence per space, because there is no such thing here
   * as a space that has been ordered — only agents that have been placed.
   */
  private locks = new Map<string, number>();
  /** paneId → its hand-set tint. Applied in `agents()` — see the note there. */
  private shades = new Map<string, AgentShade>();

  constructor(
    private readonly herdr: Herdr,
    private readonly history: History,
    private readonly projects: Projects,
    private readonly onChange: () => void,
    /**
     * The session on this pane is over — the pane closed, or `/clear` started a
     * different one on it. The board itself needs neither: it drops the row or
     * re-resolves the transcript. This is for whatever ELSE was keyed on that
     * session and cannot outlive it.
     */
    private readonly onSessionGone: (paneId: string) => void,
  ) {}

  /**
   * Begins the heartbeat and takes a first reading. Unref'd so it never holds
   * the process open on shutdown.
   */
  start(): void {
    this.schedule();
    setInterval(() => this.schedule(), HEARTBEAT_MS).unref();
  }

  /** Coalesces a burst of pushes into one snapshot read. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.resync();
    }, DEBOUNCE_MS);
  }

  /**
   * Board order, and the sole author of it: agents locked to a slot are held
   * there, everything else stays in attention order around them.
   *
   * The shade and the lock are applied HERE rather than in `resync`, and that is
   * load-bearing: `history.remember` writes a row straight out of `this.rows` to
   * disk, so either held on the row would persist against a pane id Herdr
   * recycles and come back on whatever agent inherits it. Kept off the row,
   * RECENT carries neither by construction and `history.ts` needs to know
   * nothing about any of this.
   */
  agents(): AgentRow[] {
    return arrange([...this.rows.values()].sort(compare), this.locks).map((row) => {
      const shade = this.shades.get(row.paneId) ?? null;
      const locked = this.locks.has(row.paneId);
      return shade === null && !locked ? row : { ...row, shade, locked };
    });
  }

  recent(): AgentRow[] {
    return this.history.all();
  }

  workspaceRows(): WorkspaceRow[] {
    return this.workspaces;
  }

  row(paneId: string): AgentRow | undefined {
    return this.rows.get(paneId) ?? this.history.all().find((r) => r.paneId === paneId);
  }

  workspace(id: string): WorkspaceRow | undefined {
    return this.workspaces.find((w) => w.id === id);
  }

  /**
   * Overrides the directory new agents in this space are started in.
   *
   * The grant is re-read here rather than left to the next resync, because
   * pointing a space at a delegated checkout changes what its agents will be
   * told — and a row that says otherwise for a heartbeat is saying the wrong
   * thing about permission to push.
   */
  setSpaceDir(id: string, dir: string): void {
    this.dirs.set(id, dir);
    const w = this.workspace(id);
    if (w) {
      w.dir = dir;
      w.gitDelegated = this.projects.gitDelegated(dir);
    }
    this.onChange();
  }

  /**
   * Holds one agent at a slot in its space, or releases it with `null`.
   *
   * Deleted before it is set even when it is already there, because the map's
   * insertion order is what `place` reads as recency: re-locking with `set`
   * alone leaves the key where it was, and the newest lock would then lose a
   * contested slot to the agent already holding it — a drag that visibly does
   * nothing.
   */
  lock(paneId: string, index: number | null): void {
    this.locks.delete(paneId);
    if (index !== null) this.locks.set(paneId, index);
    this.onChange();
  }

  /**
   * Releases every agent in one space, which is what the header's ⇅ does — a
   * lock is otherwise only visible on the row that has one, and resorting is the
   * one thing you want when the arrangement has stopped being useful.
   */
  unlockSpace(workspaceId: string): void {
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId) this.locks.delete(row.paneId);
    }
    this.onChange();
  }

  /** Tints one row, or clears it with `null`. */
  setShade(paneId: string, shade: AgentShade | null): void {
    if (shade === null) this.shades.delete(paneId);
    else this.shades.set(paneId, shade);
    this.onChange();
  }

  /**
   * A name Herdr will accept that no live agent already holds. Starting is
   * meant to be one click, so the name is derived rather than asked for; the
   * space label is the one thing that describes the work at that point.
   */
  nextAgentName(label: string | null): string {
    const base = deriveName(label) ?? 'agent';
    const taken = new Set([...this.rows.values()].map((r) => r.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base.slice(0, 29)}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** Parsed transcript for one agent, or empty when there is no transcript. */
  entries(paneId: string): Entry[] {
    const row = this.row(paneId);
    if (!row?.transcriptPath) return [];
    return this.transcripts.entries(row.transcriptPath);
  }

  /**
   * path → other live agents that also wrote it, for per-file diff warnings.
   * Both sides are filtered by `contends`, exactly as the board rows are.
   */
  contention(paneId: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const me = this.row(paneId);
    if (!me || !contends(me)) return out;
    const mine = new Set(touchedPaths(this.entries(paneId)));
    if (mine.size === 0) return out;
    for (const row of this.rows.values()) {
      if (row.paneId === paneId || !contends(row)) continue;
      for (const p of touchedPaths(this.entries(row.paneId))) {
        if (mine.has(p)) out.set(p, [...(out.get(p) ?? []), row.name]);
      }
    }
    return out;
  }

  private async resync(): Promise<void> {
    let panes: PaneInfo[];
    let workspaces: WorkspaceRow[];
    let names: Map<string, string>;
    try {
      const snap = await this.herdr.snapshot();
      panes = snap.panes;
      names = new Map(
        (snap.agents ?? [])
          .filter((a): a is { pane_id: string; name: string } => typeof a.name === 'string')
          .map((a) => [a.pane_id, a.name]),
      );
      workspaces = snap.workspaces.map((w) => {
        const dir = this.dirs.get(w.workspace_id) ?? commonCwd(panes, w.workspace_id);
        return {
          id: w.workspace_id,
          label: w.label,
          number: w.number,
          agentCount: 0,
          focused: w.focused,
          dir,
          gitDelegated: dir !== null && this.projects.gitDelegated(dir),
        };
      });
    } catch {
      return; // disconnected; the reconnect will resync
    }

    // A pass of its own because a fork's pane may be iterated either side of
    // its parent's, and the loop below skips it as an instrument regardless.
    const forks = forkStatuses(panes, names);

    const used = new Set<string>();
    const draft: Array<{ row: AgentRow; paths: string[] }> = [];

    for (const p of panes) {
      if (!p.agent) continue;
      // Before `syncName` below, and it has to be: that renames an agent to
      // track its terminal title, and an instrument renamed off its own name
      // can never be found again.
      if (isInstrument(names.get(p.pane_id))) continue;

      const prev = this.rows.get(p.pane_id);
      const status = asStatus(p.agent_status);
      const sessionUuid = p.agent_session?.value ?? null;
      // `/clear` keeps the pane and starts a new session on it. The row simply
      // re-resolves, but anything forked off the OLD session is now answering
      // out of a conversation that no longer exists.
      if (prev && prev.sessionUuid !== null && prev.sessionUuid !== sessionUuid) {
        this.onSessionGone(p.pane_id);
      }
      // Re-resolved every time: the session id changes on /clear, and the
      // transcript can be pruned out from under us.
      const transcriptPath = sessionUuid ? transcriptPathFor(p.cwd, sessionUuid) : null;
      const entries = transcriptPath ? this.transcripts.entries(transcriptPath) : [];
      const paths = touchedPaths(entries);
      // Counted twice, over the whole session and over the tail: the first is
      // the changelist, the second is what this assignment is answerable for.
      const assignment = assignmentOf(entries);

      const existing = names.get(p.pane_id);
      // Adopt whatever name a pane already has the FIRST time we see it —
      // `namedAs` does not survive a restart, and without this every name would
      // freeze permanently after one. Adopting here rather than at rename time
      // means a rename you make later always reads as yours and is left alone.
      if (existing !== undefined && !this.namedAs.has(p.pane_id)) {
        this.namedAs.set(p.pane_id, existing);
      }
      const desired = uniqueName(deriveName(p.terminal_title_stripped), used);
      const name = existing ?? desired ?? p.agent;
      used.add(name);

      // The fork's Herdr status, and only that. Named after this pane, so a
      // harness restart finds it again exactly as the panel does.
      const fork = forks.get(asideName(p.pane_id));
      if (fork !== undefined) this.forked.add(p.pane_id);

      const changed = prev !== undefined && prev.status !== status;
      const row: AgentRow = {
        paneId: p.pane_id,
        workspaceId: p.workspace_id,
        tabId: p.tab_id,
        name,
        status,
        cwd: p.cwd,
        repo: basename(p.cwd) || p.cwd,
        sessionUuid,
        transcriptPath,
        // Herdr exposes only a counter, so the clock has to be ours. Unknown
        // until the first transition we actually observe.
        stateSince: changed || !prev ? new Date().toISOString() : prev.stateSince,
        title: p.terminal_title_stripped ?? null,
        activity: activityOf(entries, p.cwd),
        todo: todoOf(entries),
        goal: goalOf(entries),
        assignment: assignment && {
          kind: assignment.kind,
          text: assignment.text,
          filesSince: touchedPaths(entries.slice(assignment.at)).length,
        },
        error: errorOf(entries),
        context: contextOf(entries),
        fileCount: paths.length,
        contendedWith: [],
        aside: fork ?? (this.forked.has(p.pane_id) ? 'cleared' : null),
        // Never set here: `agents()` is the author, so neither can ride a
        // remembered row onto disk.
        shade: null,
        locked: false,
        live: true,
      };

      draft.push({ row, paths });
      if (changed) this.announce(row);
      // An API error leaves the agent idle, not blocked, so Herdr's status says
      // nothing about it — this is the only thing that will tell you it stopped.
      // Announced on the transition only, and never for what was already on
      // disk when the harness started.
      if (this.started && row.error && row.error !== prev?.error) {
        notify(this.herdr, { title: `${row.name} hit an error`, body: row.error, urgent: true });
      }
      this.syncName(p, desired, existing);
    }

    annotateContention(draft);

    const next = new Map(draft.map((d) => [d.row.paneId, d.row]));
    for (const [paneId, old] of this.rows) {
      if (next.has(paneId)) continue;
      this.history.remember(old);
      // Herdr recycles pane ids, so a trace kept past the pane it describes
      // would put a fork on whatever agent inherits the id next — and equally a
      // shade, or a dead agent's hold on a slot.
      this.forked.delete(paneId);
      this.shades.delete(paneId);
      this.locks.delete(paneId);
      this.onSessionGone(paneId);
      if (this.started) {
        notify(this.herdr, {
          title: `${old.name} exited`,
          body: `${old.repo} · the pane is gone`,
          urgent: true,
        });
      }
    }

    for (const w of workspaces) {
      w.agentCount = draft.filter((d) => d.row.workspaceId === w.id).length;
    }

    this.rows = next;
    this.workspaces = workspaces;
    this.started = true;
    this.onChange();
  }

  private announce(row: AgentRow): void {
    if (row.status === 'blocked') {
      notify(this.herdr, {
        title: `${row.name} is blocked`,
        body: row.activity ?? `${row.repo} · waiting on you`,
        urgent: true,
      });
    } else if (row.status === 'done') {
      notify(this.herdr, {
        title: `${row.name} finished`,
        body: row.todo ?? row.activity ?? row.repo,
        urgent: false,
      });
    }
  }

  /**
   * Keep the agent's name tracking its terminal title.
   *
   * Naming once and freezing left rows describing work that had long since
   * moved on — an agent that spent an hour building a server still read
   * "grill-me-session-for-product". Claude Code revises its own title only
   * occasionally, so following it is cheap: a rename fires only when the
   * derived slug actually changes.
   *
   * A name we did not set is left alone. That is the whole reason `namedAs`
   * exists — without it, renaming on every title change would silently clobber
   * a name the human chose.
   */
  private syncName(pane: PaneInfo, desired: string | null, existing: string | undefined): void {
    if (!desired || desired === existing) return;
    // Generic titles produce no usable slug, so deriveName already returned null.
    // A name that is not the one we recorded was set by the human: leave it.
    if (existing !== undefined && this.namedAs.get(pane.pane_id) !== existing) return;
    if (this.namedAs.get(pane.pane_id) === desired) return; // rename already in flight

    this.namedAs.set(pane.pane_id, desired);
    void this.herdr.rename(pane.pane_id, desired).catch(() => {
      // A clash or a rejected slug is not worth reporting; the title still shows.
      this.namedAs.delete(pane.pane_id);
    });
  }

}

/**
 * The directory a space is working in, taken from the panes it already has —
 * the ones a human opened there. The commonest wins, so a stray pane in /tmp
 * does not redirect the space.
 */
function commonCwd(panes: PaneInfo[], workspaceId: string): string | null {
  const counts = new Map<string, number>();
  for (const p of panes) {
    if (p.workspace_id !== workspaceId || !p.cwd) continue;
    counts.set(p.cwd, (counts.get(p.cwd) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [cwd, n] of counts) {
    if (n > bestCount) {
      best = cwd;
      bestCount = n;
    }
  }
  return best;
}

/** Blocked first, then longest-waiting first within each status. */
function compare(a: AgentRow, b: AgentRow): number {
  const byStatus = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (byStatus !== 0) return byStatus;
  return (a.stateSince ?? '').localeCompare(b.stateSince ?? '');
}

/**
 * Puts every locked agent back at its slot, leaving everything else in the
 * attention order it arrived in.
 *
 * A second pass rather than a clause inside `compare`, and it has to be: a
 * comparator that consulted the lock for two rows of one space and the status
 * for two rows of different spaces would be intransitive (locked A<B, status
 * B<C, status C<A), and `sort` given an inconsistent comparator is free to
 * produce anything — including scrambling the very slots that were locked. Here
 * each space's members are permuted within the positions they already occupy, so
 * the result is a permutation of a totally ordered list.
 */
function arrange(rows: AgentRow[], locks: Map<string, number>): AgentRow[] {
  if (locks.size === 0) return rows;
  const out = [...rows];
  const spaces = new Set(rows.filter((r) => locks.has(r.paneId)).map((r) => r.workspaceId));
  for (const workspaceId of spaces) {
    const at: number[] = [];
    for (let i = 0; i < out.length; i++) {
      if (out[i]!.workspaceId === workspaceId) at.push(i);
    }
    const placed = place(at.map((i) => out[i]!), locks);
    at.forEach((i, n) => { out[i] = placed[n]!; });
  }
  return out;
}

/**
 * One space's agents: the locked ones at their slots, everyone else filling the
 * gaps in the order they came in, which is the attention sort.
 *
 * A slot is an absolute position in the space, so it is clamped to the list as
 * it stands now — agents come and go, and a slot recorded when the space held
 * six means nothing once it holds two. An over-large slot therefore lands on the
 * next gap ascending, and so does the loser of a contested one; it terminates
 * because there are never more locks than positions.
 *
 * The NEWEST lock wins a contested slot and displaces the incumbent to that next
 * gap, which is the only resolution that matches the gesture: dropping a row
 * where another is held has to put it there, or the insertion line promised
 * something the board then refuses. Recency is the lock map's insertion order —
 * see `Board.lock`.
 */
function place(members: AgentRow[], locks: Map<string, number>): AgentRow[] {
  const n = members.length;
  const slots: Array<AgentRow | null> = Array.from({ length: n }, () => null);
  const free = members.filter((m) => !locks.has(m.paneId));
  const recency = [...locks.keys()];
  const held = members
    .filter((m) => locks.has(m.paneId))
    .sort((a, b) =>
      locks.get(a.paneId)! - locks.get(b.paneId)!
      || recency.indexOf(b.paneId) - recency.indexOf(a.paneId));

  for (const m of held) {
    let i = Math.min(Math.max(locks.get(m.paneId)!, 0), n - 1);
    while (slots[i] !== null) i = (i + 1) % n;
    slots[i] = m;
  }
  let next = 0;
  return slots.map((m) => m ?? free[next++]!);
}

/**
 * Panes that are instruments of ours rather than the human's agents: they have
 * no work and no changelist, and an aside additionally carries a copy of its
 * parent's `toolUseResult` entries, which on the board would read as the aside
 * having done the parent's work (invariant 10). They are still real panes in
 * Herdr, labelled `usage` and `aside`, so they remain findable there.
 *
 * An aside gets no row of its own, which is the whole of what invariants 10 and
 * 18 ask for. Its STATUS is a dot on its parent's row — see `forkStatuses`.
 *
 * Matched by prefix, which means an agent the human hand-named `aside-…` would
 * vanish from the board. Deliberate: a registry of exact pane ids would not
 * survive a harness restart, and being findable by name after one is the whole
 * reason asides are named after their parent's pane.
 */
function isInstrument(name: string | undefined): boolean {
  return name === USAGE_AGENT || isAside(name);
}

/** The one rule mapping a Herdr name onto "this pane is somebody's fork". */
const isAside = (name: string | undefined): boolean => name?.startsWith(ASIDE_PREFIX) ?? false;

/**
 * Fork name → the status of the pane running it, for the one dot a fork gets on
 * its parent's row. Keyed by name because `asideName` is the only mapping there
 * is between a parent and its fork, and it does not invert.
 *
 * Nothing else about the fork is read, and nothing has to be: its pane is
 * already in the snapshot the heartbeat fetched, so this costs no request. The
 * `agent` guard is the main loop's own — a fork is present when its agent is,
 * not when a pane that once held one still exists.
 */
function forkStatuses(panes: PaneInfo[], names: Map<string, string>): Map<string, AgentStatus> {
  const out = new Map<string, AgentStatus>();
  for (const p of panes) {
    const name = names.get(p.pane_id);
    if (p.agent && name !== undefined && isAside(name)) out.set(name, asStatus(p.agent_status));
  }
  return out;
}

/**
 * Whether an agent's writes count in the contention join at all.
 *
 * An investigation is not modifying anything, so it neither reports a collision
 * nor causes one — a warning either way would be about work that is not
 * happening. The exception is an investigation that has written SINCE it began:
 * that collision is real, and the flag beside its chip is already reporting the
 * writes, so hiding them here would be the one thing invariant 10 exists to
 * prevent. Its pre-investigation files are left out with it; another agent
 * overwriting one shows up as a `stale` hunk, which is that fact's own signal.
 */
function contends(row: AgentRow): boolean {
  return row.assignment?.kind !== 'investigate' || row.assignment.filesSince > 0;
}

/**
 * Two agents that wrote the same path are contending; both rows say so. Rows
 * left out of the join keep the empty list they were built with.
 */
function annotateContention(draft: Array<{ row: AgentRow; paths: string[] }>): void {
  const writers = draft.filter(({ row }) => contends(row));
  const byPath = new Map<string, string[]>();
  for (const { row, paths } of writers) {
    for (const p of paths) byPath.set(p, [...(byPath.get(p) ?? []), row.name]);
  }
  for (const { row, paths } of writers) {
    const others = new Set<string>();
    for (const p of paths) {
      for (const other of byPath.get(p) ?? []) if (other !== row.name) others.add(other);
    }
    row.contendedWith = [...others];
  }
}

function deriveName(title: string | null | undefined): string | null {
  if (!title || GENERIC_TITLE.test(title)) return null;
  const full = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '');
  // Herdr caps names at 32 chars. Cut at a word boundary rather than mid-word:
  // "debug-missing-uuid-in-subscripti" reads worse than "debug-missing-uuid-in".
  let slug = full;
  if (slug.length > 32) {
    const cut = slug.slice(0, 32);
    const lastDash = cut.lastIndexOf('-');
    slug = lastDash > 8 ? cut.slice(0, lastDash) : cut;
  }
  slug = slug.replace(/-+$/, '');
  return /^[a-z]/.test(slug) ? slug : null;
}

function uniqueName(base: string | null, used: Set<string>): string | null {
  if (!base) return null;
  if (!used.has(base)) return base;
  for (let n = 2; n < 20; n++) {
    const candidate = `${base.slice(0, 29)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}
