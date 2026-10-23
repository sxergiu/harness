import { useEffect, useState } from 'react';
import type { SummaryView } from '@harness/shared';
import type { FileViewer } from './fileRef.js';
import { Markdown } from './Markdown.js';
import { Spinner } from './Status.js';
import { since, useApi } from './useHarness.js';

/**
 * The conversation's running brief — discussed, decided, open — which the
 * server has a haiku agent of its own bring up to date while this tab is open,
 * and only then. The view is keyed on the session, so `/clear` lands on a fresh
 * one.
 */
export function SummaryTab(
  { paneId, tick, viewer }: { paneId: string; tick: number; viewer?: FileViewer },
): React.ReactElement {
  const { get, post } = useApi();
  const [view, setView] = useState<SummaryView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    void get<SummaryView>(`/api/agents/${paneId}/summary`)
      .then((v) => { if (live) { setView(v); setFailed(null); } })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, tick, reload]);

  if (!view) {
    return failed
      ? <p className="p-3 text-xs text-red-400">⚠ could not read the summary — {failed}</p>
      : <div className="p-3 text-xs"><Spinner label="reading summary…" /></div>;
  }

  const rebuild = (): void => {
    void post(`/api/agents/${paneId}/summary`)
      .then(() => setReload((n) => n + 1))
      .catch((e: Error) => setFailed(e.message));
  };

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        <span className="text-neutral-500">{view.at ? `updated ${since(view.at)}` : 'no summary yet'}</span>
        {view.state && <Spinner label={view.state === 'running' ? 'updating…' : 'queued…'} />}
        {(view.error ?? failed) && (
          <span className="truncate text-red-400" title={view.error ?? failed ?? ''}>⚠ {view.error ?? failed}</span>
        )}
        <button
          onClick={rebuild}
          disabled={view.state !== null}
          className="ml-auto text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
          title="Rebuild the summary from the whole conversation"
        >
          ↻
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {view.text
          ? <Markdown source={view.text} viewer={viewer} />
          : (
            <p className="text-neutral-600">
              Written while this tab is open, once this agent has finished a turn, by a haiku agent of
              the harness’s own — or now, with ↻.
            </p>
          )}
      </div>
    </div>
  );
}
