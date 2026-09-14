import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENT_SHADES, type AgentRow, type AgentShade, type UsageView, type WorkspaceRow } from '@harness/shared';
import { ASSIGN, AgentView, PROMPT_ROW_H, nameTone } from './Agent.js';
import { Settings } from './Settings.js';
import { ContextMeter, ForkRing, StatusDot, Working } from './Status.js';
import { useTheme } from './theme.js';
import { since, useApi, useHarness, wantsAttention } from './useHarness.js';

/**
 * One column of spaces with their agents nested underneath, and one agent's
 * detail. Grouping is the only thing that reorders the board — inside a space
 * the order the server sent is preserved untouched, whether that is the
 * attention sort or one a human dragged the rows into.
 *
 * A space owns the directory its agents run in, so starting one is a single
 * click with nothing to fill in. Everything editable is edited in place: an
 * agent has a name, a space has a name and a directory.
 */
export function App(): React.ReactElement {
  const state = useHarness();
  const { post } = useApi();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { theme, toggle: toggleTheme } = useTheme();
  /**
   * Held here rather than in the agent view: the panel is docked to this column,
   * and the agent view remounts on every `/clear`, which would drop it.
   */
  const [usage, setUsage] = useState<UsageView | null>(null);
  /** Quitting closes the only window onto the agents, so it asks first. */
  const [confirmQuit, setConfirmQuit] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Elapsed times are relative, so the board has to re-render on its own.
  const [, setClock] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  // Spaces come and go with Herdr, so expansion is tracked as the collapsed
  // exception: a space we have never seen shows its agents.
  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const groups = useMemo(() => groupBySpace(state.agents, state.workspaces), [
    state.agents,
    state.workspaces,
  ]);
  const current = useMemo(
    () => [...state.agents, ...state.recent].find((a) => a.paneId === selected) ?? null,
    [state.agents, state.recent, selected],
  );

  // RECENT is our own cache, not Herdr's, so forgetting is immediate and has no
  // undo: the link from a closed agent to its transcript lives nowhere else.
  const forgetOne = async (paneId: string): Promise<void> => {
    await post(`/api/recent/${paneId}/remove`).catch(() => {});
    if (selected === paneId) setSelected(null);
  };

  const forgetAll = async (): Promise<void> => {
    await post('/api/recent/clear').catch(() => {});
    // Only drop the selection if it was one of the rows just forgotten.
    if (selected !== null && !state.agents.some((a) => a.paneId === selected)) setSelected(null);
  };

  /** Picking an agent is a request to look at it, so it takes the pane back. */
  const select = (paneId: string): void => {
    setSelected(paneId);
    setSettingsOpen(false);
  };

  const offline = !state.connected || !state.herdrConnected;

  return (
    <div className="flex h-screen flex-col">
      {/*
        Ahead of the offline banner, and replacing it: the socket really is down,
        but "retrying" would be a promise nothing is going to keep.
      */}
      {state.quit ? (
        <div className="bg-neutral-800 px-3 py-1 text-xs text-neutral-300">
          The harness has quit. Your agents are still running in Herdr — start it again with
          {' '}<code className="text-neutral-200">harness</code>.
        </div>
      ) : offline && (
        <div className="bg-amber-900/40 px-3 py-1 text-xs text-amber-300">
          {!state.connected
            ? '⚠ harness disconnected — retrying'
            : `⚠ Herdr disconnected${state.herdrError ? ` — ${state.herdrError}` : ''} — retrying`}
        </div>
      )}

      {/*
        Only when the board is otherwise fine — an offline banner already says
        everything, and two amber strips at once would read as two faults.
        Sky rather than amber for the same reason: nothing is wrong.
      */}
      {!offline && state.herdrWarning && (
        <div className="bg-sky-900/40 px-3 py-1 text-xs text-sky-300">ℹ {state.herdrWarning}</div>
      )}

      <div className={`flex min-h-0 flex-1 ${offline ? 'opacity-60' : ''}`}>
        {/*
          A column, not a scroll box: the usage limits are pinned to its foot and
          the spaces scroll past them. Nothing about usage belongs in the agent
          view — it is an account-wide fact that happens to be read through one
          agent's terminal.
        */}
        <aside className="flex w-96 shrink-0 flex-col border-r border-neutral-800 text-xs">
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-1 flex items-center px-1 text-neutral-500">
              <span>SPACES</span>
              {/*
                Herdr feeds pushes only to its newest subscriber, so another
                process subscribing silently and permanently stops ours — the
                board then keeps resyncing on its heartbeat but stops feeling
                live. This takes the stream back, and is the honest answer to
                "is this actually current?".
              */}
              <IconButton
                label="↻"
                title="Reclaim the event stream and resync now"
                className="ml-auto"
                onClick={() => {
                  setError(null);
                  void post('/api/refresh').catch((e: Error) => setError(e.message));
                }}
              />
              <IconButton
                label="+"
                title="New space"
                onClick={() => {
                  setError(null);
                  void post('/api/workspaces').catch((e: Error) => setError(e.message));
                }}
              />
              {/*
                Last, and after the space actions rather than among them: these
                are the app-wide controls, and the SPACES header is the only
                chrome there is to hang them on.
              */}
              <IconButton
                label={theme === 'light' ? '◐' : '◑'}
                title={`Switch to ${theme === 'light' ? 'dark' : 'light'}`}
                onClick={toggleTheme}
              />
              <IconButton
                label="⚙"
                title="Rules, checkouts and the files the agents depend on"
                onClick={() => setSettingsOpen((s) => !s)}
              />
              <IconButton
                label="⏻"
                title="Quit the harness — the agents keep running"
                onClick={() => setConfirmQuit(true)}
              />
            </div>
            {confirmQuit && (
              <div className="mb-1 flex flex-wrap items-center gap-x-2 px-1 text-amber-300">
                <span>Quit the harness? Agents keep running in Herdr; only the cockpit closes.</span>
                <button
                  onClick={() => {
                    setError(null);
                    setConfirmQuit(false);
                    void post('/api/quit').catch((e: Error) => setError(e.message));
                  }}
                  className="text-amber-200 hover:text-amber-100"
                >
                  quit
                </button>
                <button
                  onClick={() => setConfirmQuit(false)}
                  className="text-neutral-500 hover:text-neutral-300"
                >
                  cancel
                </button>
              </div>
            )}
            {error && <div className="mb-1 px-1 text-amber-400">{error}</div>}

            {groups.length === 0 && <div className="px-1 py-2 text-neutral-600">No spaces.</div>}
            {groups.map((g) => (
              <Space
                key={g.id}
                group={g}
                open={!collapsed.has(g.id)}
                onToggle={() => toggle(g.id)}
                selected={selected}
                onSelect={select}
              />
            ))}

            {state.recent.length > 0 && (
              <>
                <div className="mt-4 mb-1 flex items-center px-1 text-neutral-500">
                  <span>RECENT</span>
                  <button
                    onClick={() => void forgetAll()}
                    title="Forget every closed agent — this cannot be undone"
                    className="ml-auto px-1 text-neutral-700 hover:text-neutral-300"
                  >
                    ×
                  </button>
                </div>
                {state.recent.slice(0, 12).map((r) => (
                  // A row, not a button: the × is its own control and buttons
                  // cannot nest.
                  <div
                    key={r.paneId}
                    className={`flex items-center rounded ${
                      selected === r.paneId ? 'bg-neutral-800' : 'hover:bg-neutral-900'
                    }`}
                  >
                    <button
                      onClick={() => select(r.paneId)}
                      className={`min-w-0 flex-1 truncate px-1 py-0.5 text-left ${
                        selected === r.paneId ? 'text-neutral-200' : 'text-neutral-500'
                      }`}
                    >
                      {r.name}
                    </button>
                    <button
                      onClick={() => void forgetOne(r.paneId)}
                      title="Forget this agent"
                      className="shrink-0 px-1 text-neutral-700 hover:text-neutral-300"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>

          <UsageDock view={usage} onView={setUsage} />
        </aside>

        <main className="min-w-0 flex-1 overflow-hidden">
          {/*
            A boolean over the selection rather than a union with it: `selected`
            stays put while this is open, so closing puts you back on the agent
            you were reading.
          */}
          {settingsOpen ? (
            <Settings onClose={() => setSettingsOpen(false)} />
          ) : current ? (
            // Keyed on the session too: /clear keeps the pane but starts a new
            // transcript, and turn indices restart, so the view must remount.
            <AgentView
              key={`${current.paneId}:${current.sessionUuid ?? ''}`}
              agent={current}
              tick={state.tick}
            />
          ) : (
            <div className="p-6 text-xs text-neutral-600">Select an agent.</div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * The account's limits, pinned to the foot of the board.
 *
 * Two bars is the entire answer to the only question `/usage` is ever opened
 * for — how close am I to being cut off, and when does that reset. The panel's
 * other forty lines (cost, per-skill shares, advice about long sessions) are
 * read once out of curiosity and never again, and in a column this narrow they
 * would push the bars off the screen, so the server does not send them.
 *
 * The raw panel is the fallback and nothing more: `/usage` is a terminal dialog
 * Claude Code redraws as it likes, and when a version moves the headings, the
 * text still says what the bars cannot.
 */
function UsageDock(
  { view, onView }: { view: UsageView | null; onView: (view: UsageView | null) => void },
): React.ReactElement {
  const { post } = useApi();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /**
   * No pane in the request. The server keeps an agent of its own for this, so
   * this reads the same whether every agent is busy, blocked, or there are none
   * at all — and no agent's transcript gains a `/usage` it never asked for.
   * The first reading has to start that agent and takes ~5s; the rest are ~1s.
   */
  const read = async (): Promise<void> => {
    setBusy(true);
    setFailed(null);
    try {
      onView(await post<UsageView>('/api/usage'));
    } catch (e) {
      // Stale bars stay up — they are still the last thing that was true, and
      // they say when.
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const shut = view === null;

  return (
    // `p-2` and one prompt row are that bar's own metrics. Shut, this dock is
    // therefore exactly as tall as it, and since both are pinned to the foot of
    // their column their top borders meet as one rule across the window instead
    // of two at different heights — which is the rule the prompt box's locked
    // mode is locked to.
    <div className="shrink-0 border-t border-neutral-800 p-2 text-xs">
      <div
        style={{ height: PROMPT_ROW_H }}
        className={`flex items-center gap-2 ${shut ? '' : 'mb-1'}`}
      >
        <button
          onClick={() => (shut ? void read() : onView(null))}
          disabled={busy}
          title={shut ? 'Read /usage in the harness’s own agent' : 'Hide the limits'}
          className="flex items-center gap-1.5 text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
        >
          <span className="text-neutral-600">{shut ? '▸' : '▾'}</span>
          USAGE
        </button>
        {busy && <span className="animate-pulse text-neutral-600">reading…</span>}
        {!shut && (
          <button
            onClick={() => void read()}
            disabled={busy}
            title="Read it again"
            className="ml-auto text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
          >
            ↻
          </button>
        )}
      </div>

      {failed && <div className="truncate pb-0.5 text-amber-400" title={failed}>⚠ {failed}</div>}

      {view !== null && (
        view.limits.length > 0 ? (
          view.limits.map((limit) => {
            const on = lit(limit.percent);
            return (
            <div key={limit.label} className="py-0.5">
              {/* The lit blocks are the only coloured thing here, so they are
                  the only thing your eye is pulled to. */}
              <div className="flex items-center gap-2">
                <span className="w-12 shrink-0 text-neutral-500">{limit.label}</span>
                <span className="flex min-w-0 flex-1 gap-px">
                  {Array.from({ length: BLOCKS }, (_, i) => (
                    <span
                      key={i}
                      className={`h-2 flex-1 ${i < on ? barTone(limit.percent) : 'bg-neutral-800'}`}
                    />
                  ))}
                </span>
                <span className="w-8 shrink-0 text-right tabular-nums text-neutral-500">
                  {limit.percent}%
                </span>
              </div>
              {/*
                Every limit's own reset, aligned under its bar. Showing only the
                session's assumed the week can never bite first — but a week at
                90% and a session at 10% is exactly when you need the other date.
              */}
              {limit.resets && (
                <div className="truncate pl-14 text-neutral-600" title={limit.resets}>
                  resets {limit.resets}
                </div>
              )}
            </div>
            );
          })
        ) : (
          <pre className="max-h-40 overflow-auto text-[11px] text-neutral-500">{view.text}</pre>
        )
      )}
    </div>
  );
}


/**
 * The same thresholds the context meter uses; a limit is a limit. The bar fill
 * is the dock's only colour, so this is the only tone function it needs — the
 * percent text used to be tinted too, which made the reading redundant with the
 * bar beside it and the whole panel read as an alert.
 */
const barTone = (percent: number): string =>
  percent >= 85 ? 'bg-red-400' : percent >= 60 ? 'bg-amber-400' : 'bg-emerald-400';

/**
 * Twenty blocks, one per five percent, because a limit is a thing you read at a
 * glance and blocks are countable where a continuous fill is not. Any usage at
 * all lights one: rounding 2% down to an empty bar would say "none used" of an
 * account that has started spending.
 */
const BLOCKS = 20;
const lit = (percent: number): number => {
  const p = Math.min(100, Math.max(0, percent));
  return p > 0 ? Math.max(1, Math.round((p / 100) * BLOCKS)) : 0;
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

interface SpaceGroup {
  id: string;
  label: string;
  dir: string | null;
  /** Whether agents started here may commit and push. A fact about `dir`. */
  gitDelegated: boolean;
  /** False for the catch-all group, which Herdr has no workspace for. */
  editable: boolean;
  agents: AgentRow[];
}

/**
 * Every space Herdr reports, plus a trailing group for agents whose space it
 * did not — an agent must never be unreachable because of a missing workspace.
 */
function groupBySpace(agents: AgentRow[], workspaces: WorkspaceRow[]): SpaceGroup[] {
  const byWorkspace = new Map<string, AgentRow[]>();
  for (const a of agents) {
    const list = byWorkspace.get(a.workspaceId);
    if (list) list.push(a);
    else byWorkspace.set(a.workspaceId, [a]);
  }

  const groups: SpaceGroup[] = workspaces.map((w) => ({
    id: w.id,
    label: w.label ?? String(w.number),
    dir: w.dir,
    gitDelegated: w.gitDelegated,
    editable: true,
    agents: byWorkspace.get(w.id) ?? [],
  }));

  const known = new Set(workspaces.map((w) => w.id));
  const orphans = agents.filter((a) => !known.has(a.workspaceId));
  if (orphans.length > 0) {
    groups.push({
      id: ' orphans',
      label: 'no space',
      dir: null,
      gitDelegated: false,
      editable: false,
      agents: orphans,
    });
  }
  return groups;
}

/** "…/repos/web.app" — enough of the path to recognise, short enough to fit. */
function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

function Space(
  { group, open, onToggle, selected, onSelect }: {
    group: SpaceGroup;
    open: boolean;
    onToggle: () => void;
    selected: string | null;
    onSelect: (paneId: string) => void;
  },
): React.ReactElement {
  const { post } = useApi();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Only ever set for a space that still has agents — see `close`. */
  const [confirming, setConfirming] = useState(false);
  /**
   * The drag in flight, held by the space rather than the row because the space
   * is what owns the list. It also makes the "within a space only" boundary
   * free: another space has no drag of its own, never accepts the dragover, and
   * so the browser refuses the drop with no id comparison anywhere.
   */
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const attention = group.agents.filter(wantsAttention).length;
  const ids = group.agents.map((a) => a.paneId);

  /** One click, no form: the space already knows where and what to call it. */
  const add = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const { paneId } = await post<{ paneId: string }>(`/api/workspaces/${group.id}/agents`);
      onSelect(paneId);
    } catch (e) {
      // The likeliest failure is a space with no directory yet, so offer it.
      setError((e as Error).message);
      setEditing(true);
    } finally {
      setBusy(false);
    }
  };

  const save = async (label: string, dir: string, gitDelegated: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (label && label !== group.label) {
        await post(`/api/workspaces/${group.id}/rename`, { label });
      }
      // The grant rides on the dir route, so a tick with no path change still
      // has to go — testing the dir alone would make the checkbox a control
      // that silently does nothing. But it goes ONLY when the box itself moved:
      // the checkbox was seeded from the old directory's grant, so sending it
      // alongside a new path would decide that path's permissions from a fact
      // about a different checkout. Omitted, the server leaves the grant alone.
      const granted = gitDelegated !== group.gitDelegated;
      if (dir && (dir !== group.dir || granted)) {
        await post(`/api/workspaces/${group.id}/dir`, {
          dir,
          ...(granted ? { gitDelegated } : {}),
        });
      }
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Locks the dragged agent at the slot it landed on, and only that agent —
   * everything else stays unlocked and keeps sorting by attention around it.
   *
   * The slot is read back out of the sequence the drop would produce rather than
   * derived from the target's index, so the two directions need no separate
   * arithmetic: dragging DOWN onto a row lands below it, dragging up lands
   * above, and either way the row ends where the insertion line was.
   */
  const drop = async (onto: string): Promise<void> => {
    const from = dragging;
    setDragging(null);
    setOver(null);
    if (from === null || from === onto) return;
    const rest = ids.filter((id) => id !== from);
    const at = rest.indexOf(onto);
    if (at === -1) return;
    rest.splice(ids.indexOf(from) < ids.indexOf(onto) ? at + 1 : at, 0, from);
    setError(null);
    await post(`/api/agents/${from}/lock`, { index: rest.indexOf(from) })
      .catch((e: Error) => setError(e.message));
  };

  /** Locks an agent where it currently sits, or releases it. */
  const toggleLock = async (paneId: string, locked: boolean): Promise<void> => {
    setError(null);
    await post(`/api/agents/${paneId}/lock`, { index: locked ? null : ids.indexOf(paneId) })
      .catch((e: Error) => setError(e.message));
  };

  /**
   * Which edge of a row the insertion line sits on, matching `drop`'s rule.
   *
   * The dragged row still has to be one of ours: if its pane exits mid-drag the
   * grip unmounts with it, no `dragend` ever reaches `onEnd`, and the line would
   * otherwise sit on whichever row was last hovered with nothing left to clear it.
   */
  const marker = (paneId: string): 'top' | 'bottom' | null => {
    if (over !== paneId || dragging === null || dragging === paneId) return null;
    if (!ids.includes(dragging)) return null;
    return ids.indexOf(dragging) < ids.indexOf(paneId) ? 'bottom' : 'top';
  };

  /**
   * Closing an empty space is just tidying up after a stray `+`, so it happens
   * on the click. Closing one with agents in it kills them, so that asks first —
   * the difference is what makes the icon safe to put next to `+`.
   */
  const close = async (): Promise<void> => {
    if (group.agents.length > 0 && !confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await post(`/api/workspaces/${group.id}/close`);
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group/space mb-1">
      {editing ? (
        <SpaceEditor
          label={group.label}
          dir={group.dir ?? ''}
          gitDelegated={group.gitDelegated}
          busy={busy}
          onCancel={() => { setEditing(false); setError(null); }}
          onSave={(label, dir, gitDelegated) => void save(label, dir, gitDelegated)}
        />
      ) : (
        <div className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-neutral-900">
          <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1 text-left">
            <span className="w-2 shrink-0 text-neutral-600">{open ? '▾' : '▸'}</span>
            <span className="shrink-0 text-neutral-300">{group.label}</span>
            {group.dir && (
              <span className="truncate text-neutral-600" title={group.dir}>
                {shortPath(group.dir)}
              </span>
            )}
            {/*
              Neutral, and that is the whole choice: every coloured thing on
              this column is a claim about an agent's state, and this is a claim
              about configuration. A permission you can only see by opening the
              editor is one you forget you granted.
            */}
            {group.gitDelegated && (
              <span
                className="shrink-0 text-neutral-400"
                title="git is delegated in this checkout — agents started here may commit and push"
              >
                git
              </span>
            )}
            {/* Collapsing hides rows, so attention has to survive on the header. */}
            {!open && attention > 0 && <span className="shrink-0 text-amber-400">{attention}!</span>}
            <span className="ml-auto shrink-0 pl-1 text-neutral-600">{group.agents.length}</span>
          </button>
          {/*
            Outside the hover strip, and deliberately: this is the way out of an
            arrangement, and it has to be on screen without hunting for it.
            Derived from the rows rather than reported by the space — "does this
            space hold a locked agent" is not a second fact to keep in step.
          */}
          {group.editable && group.agents.some((a) => a.locked) && (
            <IconButton
              label="⇅"
              title="Release every locked agent here and sort by attention again"
              onClick={() => {
                setError(null);
                void post(`/api/workspaces/${group.id}/unlock`)
                  .catch((e: Error) => setError(e.message));
              }}
            />
          )}
          {group.editable && (
            <div className="flex shrink-0 gap-0.5 opacity-0 group-hover/space:opacity-100">
              <IconButton label="✎" title="Rename this space, or change its directory" onClick={() => setEditing(true)} />
              <IconButton label={busy ? '·' : '+'} title="Start an agent here" onClick={() => void add()} />
              <IconButton
                label="✕"
                title={group.agents.length > 0 ? 'Close this space — it has agents in it' : 'Close this space'}
                onClick={() => void close()}
              />
            </div>
          )}
        </div>
      )}

      {confirming && (
        <div className="flex items-center gap-2 px-1 pb-0.5 pl-4 text-amber-300">
          <span>
            Close {group.label}? {group.agents.length} agent
            {group.agents.length === 1 ? '' : 's'} die with it.
          </span>
          <button onClick={() => void close()} className="text-amber-200 hover:text-amber-100">close</button>
          <button onClick={() => setConfirming(false)} className="text-neutral-500 hover:text-neutral-300">cancel</button>
        </div>
      )}

      {error && <div className="px-1 pb-0.5 pl-4 text-amber-400">{error}</div>}

      {open && (
        <div className="ml-2 border-l border-neutral-800">
          {group.agents.length === 0 && <div className="py-1 pl-2 text-neutral-700">empty</div>}
          {group.agents.map((a) => (
            <BoardRow
              key={a.paneId}
              agent={a}
              active={selected === a.paneId}
              onClick={() => onSelect(a.paneId)}
              // Null for the orphan group: there is no space to order.
              drag={!group.editable ? null : {
                marker: marker(a.paneId),
                onStart: () => setDragging(a.paneId),
                // The only thing that covers a drop outside every row, and an
                // Escape-cancelled drag.
                onEnd: () => { setDragging(null); setOver(null); },
                onOver: (e) => {
                  if (dragging === null) return;
                  // Without this the drop event never fires at all.
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setOver(a.paneId);
                },
                onLeave: () => setOver((id) => (id === a.paneId ? null : id)),
                onDrop: () => void drop(a.paneId),
                onToggleLock: () => void toggleLock(a.paneId, a.locked),
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A space is a name, a directory, and what agents started there are allowed to
 * do with git. Edited in the row itself.
 */
function SpaceEditor(
  { label, dir, gitDelegated, busy, onSave, onCancel }: {
    label: string;
    dir: string;
    gitDelegated: boolean;
    busy: boolean;
    onSave: (label: string, dir: string, gitDelegated: boolean) => void;
    onCancel: () => void;
  },
): React.ReactElement {
  const [nextLabel, setNextLabel] = useState(label);
  const [nextDir, setNextDir] = useState(dir);
  const [nextGit, setNextGit] = useState(gitDelegated);

  const keys = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') onSave(nextLabel.trim(), nextDir.trim(), nextGit);
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div className="rounded bg-neutral-900 p-1">
      <input
        autoFocus
        value={nextLabel}
        onChange={(e) => setNextLabel(e.target.value)}
        onKeyDown={keys}
        placeholder="name"
        className="mb-1 w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-200"
      />
      <input
        value={nextDir}
        onChange={(e) => setNextDir(e.target.value)}
        onKeyDown={keys}
        placeholder="~/repos/…  — where agents here run"
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-200"
      />
      {/*
        Both caveats are on screen rather than in a tooltip, because both are
        invisible once the box is ticked: the grant is on the PATH, so it
        follows the checkout into every other space pointed at it, and the
        system prompt is fixed when an agent starts, so agents already running
        keep whatever they were told.
      */}
      <label className="mt-1 flex cursor-pointer items-start gap-1.5 px-1 py-0.5 text-neutral-400 hover:text-neutral-200">
        <input
          type="checkbox"
          checked={nextGit}
          onChange={(e) => setNextGit(e.target.checked)}
          className="mt-0.5 shrink-0"
        />
        <span>
          allow agents to commit and push here
          <span className="block text-neutral-600">
            applies to this checkout, so every space on the same path shares it — and only to
            agents started from now on
          </span>
        </span>
      </label>
      <div className="mt-1 flex justify-end gap-2">
        <button className="text-neutral-500 hover:text-neutral-300" onClick={onCancel}>cancel</button>
        <button
          disabled={busy}
          className="text-neutral-300 hover:text-neutral-100 disabled:opacity-40"
          onClick={() => onSave(nextLabel.trim(), nextDir.trim(), nextGit)}
        >
          save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent row
// ---------------------------------------------------------------------------

/**
 * What a row needs to take part in its space's reordering. One object rather
 * than five loose props, and null where a group is not a space at all — that
 * absence is the whole of the "within a space only" rule on this side.
 */
interface RowDrag {
  /** The edge the insertion line sits on while this row is the drop target. */
  marker: 'top' | 'bottom' | null;
  onStart: () => void;
  onEnd: () => void;
  onOver: (e: React.DragEvent) => void;
  onLeave: () => void;
  onDrop: () => void;
  /** Lock this agent where it sits, or release it. The grip's click. */
  onToggleLock: () => void;
}

/**
 * A row's tint, cycled by right-clicking it, for telling apart rows that Herdr
 * gives you nothing to tell apart by.
 *
 * The distinction is carried by HUE and not by brightness: washes of one grey
 * differ by a few percent of luminance against a near-black page and simply do
 * not read across a column you are scanning.
 *
 * The hue STEPS are not uniform, and that is the point — `teal-500` and
 * `lime-500` are light colours, so one alpha across all five would produce
 * washes differing in brightness as much as in hue, and brightness is the
 * channel selection uses. Dropped to `-700`, all five land within 1.93–2.06
 * contrast for the row's recessive `text-neutral-600`, against 1.94 for the
 * selected row today.
 *
 * A shaded row does NOT brighten further when selected: `inset-ring` marks that
 * instead, which is what stops the wash having to climb — at /45 the greens pass
 * straight through the muted text's own luminance and it vanishes (measured 1.04
 * for lime). The cost of the hue is a modest loss on that recessive text, and
 * the primary name stays above 8:1 throughout.
 *
 * `none` keeps the classes the row has always had, so a row nobody has shaded is
 * unchanged.
 *
 * Every class is written out because Tailwind scans source text for candidates:
 * a template-built `bg-${hue}-500/25` compiles to no CSS at all, silently.
 */
const SHADE: Record<'none' | AgentShade, { rest: string; hover: string; active: string }> = {
  none: { rest: '', hover: 'hover:bg-neutral-900', active: 'bg-neutral-800' },
  indigo: { rest: 'bg-indigo-500/25', hover: 'hover:bg-indigo-500/35', active: 'bg-indigo-500/35' },
  teal: { rest: 'bg-teal-700/25', hover: 'hover:bg-teal-700/35', active: 'bg-teal-700/35' },
  lime: { rest: 'bg-lime-700/25', hover: 'hover:bg-lime-700/35', active: 'bg-lime-700/35' },
  rose: { rest: 'bg-rose-500/25', hover: 'hover:bg-rose-500/35', active: 'bg-rose-500/35' },
  purple: { rest: 'bg-purple-500/25', hover: 'hover:bg-purple-500/35', active: 'bg-purple-500/35' },
};

/**
 * The next tint in the queue, and off the end back to none.
 *
 * The `?? null` is load-bearing despite the types calling it redundant:
 * `noUncheckedIndexedAccess` is off, so a read past the end of the array is
 * typed `AgentShade` while actually being `undefined`. Without it the queue
 * hands `undefined` to the route at the wrap and never clears a shade.
 */
const nextShade = (shade: AgentShade | null): AgentShade | null =>
  shade === null ? AGENT_SHADES[0] : (AGENT_SHADES[AGENT_SHADES.indexOf(shade) + 1] ?? null);

function BoardRow(
  { agent, active, onClick, drag }: {
    agent: AgentRow;
    active: boolean;
    onClick: () => void;
    drag: RowDrag | null;
  },
): React.ReactElement {
  const { post } = useApi();
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  /** The drag image: the row itself, not the illegible 12px glyph you grabbed. */
  const rowRef = useRef<HTMLDivElement | null>(null);
  const shade = SHADE[agent.shade ?? 'none'];

  const cycleShade = async (): Promise<void> => {
    setError(null);
    await post(`/api/agents/${agent.paneId}/shade`, { shade: nextShade(agent.shade) })
      .catch((e: Error) => setError(e.message));
  };

  const rename = async (name: string): Promise<void> => {
    setError(null);
    try {
      await post(`/api/agents/${agent.paneId}/rename`, { name });
      setRenaming(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  /**
   * Closes the tab, which ends the agent AND removes its pane. `/exit` ends the
   * session but leaves the pane behind as a bare shell that the cockpit no
   * longer shows — this is the one action that leaves nothing behind, so it
   * always asks first.
   *
   * The tab is closed by id rather than the pane, because a tab is what `+`
   * created.
   */
  const close = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setClosing(true);
    setError(null);
    try {
      await post(`/api/tabs/${agent.tabId}/close`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClosing(false);
      setConfirming(false);
    }
  };

  if (renaming) {
    return (
      <div className="border-b border-neutral-900 p-1 pl-2">
        <NameEditor
          name={agent.name}
          onSave={(name) => void rename(name)}
          onCancel={() => { setRenaming(false); setError(null); }}
        />
        {error && <div className="pt-0.5 text-amber-400">{error}</div>}
      </div>
    );
  }

  return (
    <div
      ref={rowRef}
      // The selected row is ringed as well as lit, because once rows carry
      // shades of their own "brighter" no longer means "selected" — an s3 row
      // at rest sits within a step of an unshaded selected one.
      className={`group/row relative flex items-start border-b border-neutral-900 ${
        active ? `${shade.active} inset-ring-1 inset-ring-neutral-600` : `${shade.rest} ${shade.hover}`
      }`}
      // Right-click steps to the next tint. No menu: the queue is short and one
      // gesture on the row itself beats aiming at a swatch, which is also why
      // the native context menu is suppressed rather than replaced.
      onContextMenu={(e) => {
        e.preventDefault();
        if (agent.live) void cycleShade();
      }}
      onDragOver={drag?.onOver}
      onDragLeave={drag?.onLeave}
      onDrop={drag ? (e) => { e.preventDefault(); drag.onDrop(); } : undefined}
    >
      {drag?.marker && (
        // In the gutter between rows rather than as a border, which would jog
        // the row by a pixel as the line appears.
        <div
          className={`pointer-events-none absolute inset-x-0 h-px bg-neutral-400 ${
            drag.marker === 'top' ? '-top-px' : '-bottom-px'
          }`}
        />
      )}
      <button onClick={onClick} className="min-w-0 flex-1 py-1 pl-2 text-left text-xs">
        <div className="flex items-center gap-2">
          <ForkRing fork={agent.aside}>
            <StatusDot agent={agent} />
          </ForkRing>
          {/* On the name, never on the dot: the dot means status and nothing else. */}
          <span className={`truncate ${nameTone(agent.assignment)}`}>{agent.name}</span>
          <ContextMeter context={agent.context} />
          <span className="ml-auto shrink-0 text-neutral-600">{agent.repo}</span>
          <span className="w-8 shrink-0 text-right text-neutral-600">{since(agent.stateSince)}</span>
        </div>
        {/* An error outranks everything else the row could say about now. */}
        {agent.error && (
          <div className="truncate pl-6 text-red-400" title={agent.error}>⚠ {agent.error}</div>
        )}
        {agent.goal && (
        <div className={`truncate pl-6 ${agent.goal.met ? 'text-emerald-500' : 'text-violet-400'}`}>
          ◎ {agent.goal.condition}
        </div>
      )}
        {/* Above the todo because it frames it: what the session was set going
            on, then where that has got to. */}
        {agent.assignment && (
          <div
            className={`truncate pl-6 ${ASSIGN[agent.assignment.kind].tone}`}
            title={agent.assignment.text}
          >
            {ASSIGN[agent.assignment.kind].glyph} {agent.assignment.text}
          </div>
        )}
        {/* An investigation that has written files contradicts its own chip, so
            it says so directly under it. Nothing stopped it — this is the whole
            of what the harness can do about it. */}
        {agent.assignment?.kind === 'investigate' && agent.assignment.filesSince > 0 && (
          <div className="truncate pl-6 text-amber-500">
            ⚠ wrote {agent.assignment.filesSince} file
            {agent.assignment.filesSince === 1 ? '' : 's'} while investigating
          </div>
        )}
      {agent.todo && <div className="truncate pl-6 text-neutral-400">▸ {agent.todo}</div>}
        {/* Live work reads as live; the same line goes quiet once it stops. */}
        {agent.status === 'working' && !agent.error ? (
          <div className="flex pl-6"><Working agent={agent} /></div>
        ) : (
          agent.activity && <div className="truncate pl-6 text-neutral-600">{agent.activity}</div>
        )}
        {agent.contendedWith.length > 0 && (
          <div className="truncate pl-6 text-amber-500">
            ⚠ contending with {agent.contendedWith.join(', ')}
          </div>
        )}
      </button>
      {/*
        Reserved width rather than an overlay: nothing shifts, nothing is hidden.
        Right-aligned so ✎ and ✕ land in the same place whether or not this row
        has a grip — an unhovered grip only goes transparent and keeps its box,
        but a group with no drag at all omits it outright.
      */}
      <div className="flex w-14 shrink-0 justify-end pt-1">
        {agent.live && drag && (
          /*
            The drag starts from a grip and not from the row, which is almost
            entirely covered by a <button>: a button swallows the initiating
            mousedown unevenly across engines, and an aborted drag on the row
            would fire its click and select the agent. It sits before ✎ and ✕ so
            a mis-grab hits a button rather than starting a drag.

            A locked agent shows its grip whether or not you are hovering, and
            that is why the grip is outside the strip below — opacity on the
            parent cannot be undone by a child. Being on screen IS the lock
            indicator: an agent held out of the attention sort with nothing
            saying so is an order you cannot account for.
          */
          <span
            draggable
            title={agent.locked
              ? 'Locked to this position — click to release it'
              : 'Drag to lock this agent to a position, or click to lock it here'}
            onClick={drag.onToggleLock}
            onDragStart={(e) => {
              // Firefox will not begin a drag without data on the transfer.
              e.dataTransfer.setData('text/plain', agent.paneId);
              e.dataTransfer.effectAllowed = 'move';
              if (rowRef.current) e.dataTransfer.setDragImage(rowRef.current, 8, 8);
              drag.onStart();
            }}
            onDragEnd={drag.onEnd}
            className={`cursor-grab px-1 select-none hover:text-neutral-200 ${
              agent.locked
                ? 'text-neutral-300'
                : 'text-neutral-500 opacity-0 group-hover/row:opacity-100'
            }`}
          >
            ⠿
          </span>
        )}
        {agent.live && (
          <span className="flex opacity-0 group-hover/row:opacity-100">
            <IconButton label="✎" title="Rename this agent" onClick={() => setRenaming(true)} />
            <IconButton
              label={closing ? '·' : '✕'}
              title="Close this agent's tab — ends it and takes the pane with it"
              onClick={() => void close()}
            />
          </span>
        )}
      </div>
      {confirming && (
        <div className="absolute right-0 flex items-center gap-2 bg-neutral-950 px-2 py-1 text-amber-300 shadow">
          <span>End {agent.name} and close its tab?</span>
          <button onClick={() => void close()} className="text-amber-200 hover:text-amber-100">close</button>
          <button onClick={() => setConfirming(false)} className="text-neutral-500 hover:text-neutral-300">cancel</button>
        </div>
      )}
    </div>
  );
}

function NameEditor(
  { name, onSave, onCancel }: { name: string; onSave: (name: string) => void; onCancel: () => void },
): React.ReactElement {
  const [next, setNext] = useState(name);
  return (
    <input
      autoFocus
      value={next}
      onChange={(e) => setNext(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSave(next.trim());
        if (e.key === 'Escape') onCancel();
      }}
      className="w-full rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-neutral-200"
    />
  );
}

function IconButton(
  { label, title, onClick, className = '' }: {
    label: string;
    title: string;
    onClick: () => void;
    className?: string;
  },
): React.ReactElement {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`rounded px-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 ${className}`}
    >
      {label}
    </button>
  );
}
