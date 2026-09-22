import { useEffect, useState } from 'react';
import type { FeedEntry, SubagentRow, SubagentsView } from '@harness/shared';
import { EntryRow } from './Feed.js';
import type { FileViewer } from './fileRef.js';
import { Spinner, SubagentDot, subagentText } from './Status.js';
import { useApi } from './useHarness.js';

/**
 * Every subagent of one agent, with what it is doing right now.
 *
 * The list comes from the subagents directory rather than from the parent's
 * tool calls, because the parent only records a subagent once it has finished —
 * a list built from tool results cannot show the one still running. Its
 * transcript renders with the same `EntryRow` the parent's feed uses: a tool
 * call must not look like one thing there and another thing here.
 *
 * Two layouts over one set of rows. Stacked reads like the feed and is best for
 * a handful; split reads like the diff and is best once the list is long enough
 * that scrolling past one subagent to reach another becomes the cost.
 */
export function SubagentsTab(
  { paneId, tick, viewer }: { paneId: string; tick: number; viewer?: FileViewer },
): React.ReactElement {
  const { get } = useApi();
  const [rows, setRows] = useState<SubagentRow[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [mode, setMode] = useState<'stacked' | 'split'>('stacked');
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let live = true;
    void get<SubagentsView>(`/api/agents/${paneId}/subagents`)
      .then((v) => { if (live) { setRows(v.subagents); setFailed(null); } })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, tick]);

  if (!rows) {
    return failed
      ? <p className="p-3 text-xs text-red-400">⚠ could not list subagents — {failed}</p>
      : <div className="p-3 text-xs"><Spinner label="listing subagents…" /></div>;
  }

  if (rows.length === 0) {
    return (
      <div className="p-3">
        <p className="text-sm text-neutral-400">This agent has run no subagents.</p>
        <p className="mt-2 text-xs text-neutral-600">
          Listed from its own transcript directory, so one appears here as soon as it starts —
          before the parent has any result for it.
        </p>
      </div>
    );
  }

  const toggle = (id: string): void =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // Selection survives a refetch, and falls back only when the row is gone.
  const current = rows.find((r) => r.agentId === selected) ?? rows[0]!;
  const live = rows.filter((r) => r.status === 'running' || r.status === 'waiting').length;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        <span className="text-neutral-500">
          {rows.length} subagent{rows.length === 1 ? '' : 's'}
        </span>
        {live > 0 && <span className="text-sky-400">{live} live</span>}
        {failed && (
          <span className="truncate text-red-400" title={failed}>⚠ refresh failed</span>
        )}
        <button
          onClick={() => setMode(mode === 'stacked' ? 'split' : 'stacked')}
          className="ml-auto text-neutral-500 hover:text-neutral-200"
          title="Toggle stacked / split"
        >
          {mode}
        </button>
      </div>

      {mode === 'stacked' ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {rows.map((row) => (
            <div key={row.agentId} className="mb-1 border-b border-neutral-900 pb-1">
              <button
                onClick={() => toggle(row.agentId)}
                className="w-full text-left hover:bg-neutral-900"
              >
                <Summary row={row} caret={open.has(row.agentId) ? '▾' : '▸'} />
              </button>
              {open.has(row.agentId) && (
                <div className="ml-4 border-l border-neutral-800 pl-2">
                  <Detail paneId={paneId} row={row} tick={tick} viewer={viewer} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav className="w-72 shrink-0 overflow-y-auto border-r border-neutral-800">
            {rows.map((row) => (
              <button
                key={row.agentId}
                onClick={() => setSelected(row.agentId)}
                className={`w-full border-b border-neutral-900 text-left ${
                  current.agentId === row.agentId ? 'bg-neutral-800' : 'hover:bg-neutral-900'
                }`}
              >
                <Summary row={row} narrow />
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-2">
            <Detail paneId={paneId} row={current} tick={tick} viewer={viewer} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The one place a subagent is described, used by both layouts. The activity
 * line is the newest tool call — the same derivation the board uses for an
 * agent, so "what is it doing" reads identically at both levels.
 *
 * `narrow` is the split list, where the column is 288px: the prompt gets its
 * own line there, because sharing one with the metrics crushed it to "You ar…".
 */
function Summary(
  { row, caret, narrow = false }: { row: SubagentRow; caret?: string; narrow?: boolean },
): React.ReactElement {
  const description = (
    <span className="min-w-0 truncate text-neutral-600" title={row.description}>
      {row.description}
    </span>
  );

  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-2">
        {caret !== undefined && <span className="shrink-0 text-neutral-700">{caret}</span>}
        <SubagentDot status={row.status} />
        <span className={`shrink-0 ${subagentText(row.status)}`}>{row.agentType}</span>
        {!narrow && description}
        <span className="ml-auto shrink-0 text-neutral-700">{row.toolUseCount} tools</span>
        {row.durationMs !== null && (
          <span className="shrink-0 text-neutral-700">{duration(row.durationMs)}</span>
        )}
      </div>
      {narrow && <div className="flex pl-4">{description}</div>}
      {row.activity && (
        <div
          className={`truncate pl-4 ${row.status === 'running' ? 'text-sky-300/90' : 'text-neutral-600'}`}
          title={row.activity}
        >
          {row.activity}
        </div>
      )}
    </div>
  );
}

/**
 * A subagent's transcript, plus what it handed back. The feed refetches on the
 * board's tick, so an open running subagent updates as it works.
 */
function Detail(
  { paneId, row, tick, viewer }: {
    paneId: string;
    row: SubagentRow;
    tick: number;
    viewer?: FileViewer;
  },
): React.ReactElement {
  return (
    <>
      <SubagentFeed paneId={paneId} agentId={row.agentId} tick={tick} viewer={viewer} />
      {row.output !== null && (
        <div className="my-2 rounded border border-neutral-800 bg-neutral-900/50 p-2">
          <div className="mb-1 text-neutral-500">returned to the parent</div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-neutral-400">
            {row.output}
          </pre>
        </div>
      )}
      {row.output === null && row.status !== 'running' && row.status !== 'waiting' && (
        <div className="my-2 text-neutral-600">
          This subagent never returned a result to the parent.
        </div>
      )}
    </>
  );
}

function SubagentFeed(
  { paneId, agentId, tick, viewer }: {
    paneId: string;
    agentId: string;
    tick: number;
    viewer?: FileViewer;
  },
): React.ReactElement {
  const { get } = useApi();
  const [entries, setEntries] = useState<FeedEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void get<{ entries: FeedEntry[] }>(`/api/agents/${paneId}/subagent/${agentId}`)
      .then((r) => { if (live) { setEntries(r.entries); setFailed(null); } })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, agentId, tick]);

  if (!entries) {
    return failed
      ? <p className="text-red-400">⚠ could not read this subagent — {failed}</p>
      : <Spinner label="reading subagent transcript…" />;
  }
  if (entries.length === 0) {
    return <p className="text-neutral-600">Nothing recorded in this subagent's transcript yet.</p>;
  }
  return <>{entries.map((e, i) => <EntryRow key={i} entry={e} viewer={viewer} />)}</>;
}

/** "4m" / "31s" — subagents are minutes-scale, so seconds matter below one. */
function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`;
}
