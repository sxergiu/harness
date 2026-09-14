import { useEffect, useMemo, useState } from 'react';
import type { AgentDiff, DiffFile, DiffHunk, DiffLine, FileContent } from '@harness/shared';
import { highlight } from './highlight.js';
import { Spinner } from './Status.js';
import { useApi } from './useHarness.js';

/** Files whose path has no directory. Sorts last, after every real directory. */
const ROOT_DIR = '·';

interface DirGroup {
  dir: string;
  files: DiffFile[];
}

/**
 * One level per directory, not per path segment: `server/src` is a single row
 * rather than `server` wrapping `src`. Nesting every segment would spend two
 * levels of indentation before reaching a filename you can actually read.
 */
function groupByDir(files: DiffFile[]): DirGroup[] {
  const byDir = new Map<string, DiffFile[]>();
  for (const f of files) {
    const slash = f.relPath.lastIndexOf('/');
    const dir = slash < 0 ? ROOT_DIR : f.relPath.slice(0, slash);
    const list = byDir.get(dir);
    if (list) list.push(f);
    else byDir.set(dir, [f]);
  }

  return [...byDir.entries()]
    .map(([dir, group]) => ({
      dir,
      files: [...group].sort((a, b) => baseName(a.relPath).localeCompare(baseName(b.relPath))),
    }))
    .sort((a, b) => {
      if (a.dir === ROOT_DIR) return 1;
      if (b.dir === ROOT_DIR) return -1;
      return a.dir.localeCompare(b.dir);
    });
}

function baseName(relPath: string): string {
  return relPath.slice(relPath.lastIndexOf('/') + 1);
}

export function DiffTab({ paneId, tick }: { paneId: string; tick: number }): React.ReactElement {
  const { get } = useApi();
  const [diff, setDiff] = useState<AgentDiff | null>(null);
  const [mode, setMode] = useState<'unified' | 'split'>('unified');
  const [selected, setSelected] = useState<string | null>(null);
  const [closedDirs, setClosedDirs] = useState<ReadonlySet<string>>(new Set());

  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void get<AgentDiff>(`/api/agents/${paneId}/diff`)
      .then((d) => { if (live) { setDiff(d); setFailed(null); } })
      // Swallowing this left the panel on "Loading diff…" for good. A refresh
      // that fails keeps the diff already on screen and says so above it.
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, tick]);

  const groups = useMemo(() => groupByDir(diff?.files ?? []), [diff]);

  if (!diff) {
    return failed
      ? <p className="p-3 text-xs text-red-400">⚠ could not read the diff — {failed}</p>
      : <div className="p-3 text-xs"><Spinner label="building diff…" /></div>;
  }

  if (!diff.files.length) {
    return (
      <div className="p-3">
        <p className="text-sm text-neutral-400">This agent has changed no files.</p>
        <p className="mt-2 text-xs text-neutral-600">
          Built from this agent's own Write/Edit results. A file written by a shell command, or by
          one of its subagents, records no tool call and cannot appear here.
        </p>
      </div>
    );
  }

  const totals = diff.files.reduce(
    (acc, f) => ({ add: acc.add + f.additions, del: acc.del + f.deletions }),
    { add: 0, del: 0 },
  );

  // The agent keeps writing while you read. A refetch must not throw away what
  // you were looking at, so the selection falls back only when the file is gone.
  const current = diff.files.find((f) => f.path === selected) ?? diff.files[0]!;

  const toggleDir = (dir: string): void =>
    setClosedDirs((prev) => {
      const next = new Set(prev);
      if (!next.delete(dir)) next.add(dir);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      {/* A failed REFRESH: what is below is real, just not current. */}
      {failed && (
        <div className="shrink-0 border-b border-red-900/60 bg-red-950/30 px-2 py-1 text-red-300">
          ⚠ showing the last diff read — refresh failed: {failed}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <nav className="w-60 shrink-0 overflow-y-auto border-r border-neutral-800">
        <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
          <span className="text-neutral-500">
            {diff.files.length} file{diff.files.length === 1 ? '' : 's'}
          </span>
          <span className="text-emerald-400">+{totals.add}</span>
          <span className="text-red-400">−{totals.del}</span>
          <button
            onClick={() => setMode(mode === 'unified' ? 'split' : 'unified')}
            className="ml-auto text-neutral-500 hover:text-neutral-200"
            title="Toggle unified / split"
          >
            {mode}
          </button>
        </div>

        {groups.map((g) => (
          <div key={g.dir}>
            <button
              onClick={() => toggleDir(g.dir)}
              className="flex w-full items-center gap-1 px-2 py-1 text-left text-neutral-500 hover:text-neutral-300"
            >
              <span className="text-neutral-700">{closedDirs.has(g.dir) ? '▸' : '▾'}</span>
              <span className="truncate">{g.dir}</span>
              <span className="ml-auto text-neutral-700">{g.files.length}</span>
            </button>

            {!closedDirs.has(g.dir) && g.files.map((f) => (
              <button
                key={f.path}
                onClick={() => setSelected(f.path)}
                className={`flex w-full items-baseline gap-1 py-0.5 pl-5 pr-2 text-left ${
                  current.path === f.path
                    ? 'bg-neutral-800 text-neutral-200'
                    : 'text-neutral-400 hover:bg-neutral-900'
                }`}
              >
                <span className="truncate">{baseName(f.relPath)}</span>
                {f.hunks.some((h) => h.stale) && (
                  <span
                    className="shrink-0 text-amber-500"
                    title={`${f.hunks.filter((h) => h.stale).length} of this file's changes have been overwritten`}
                  >
                    ~
                  </span>
                )}
                {f.contendedWith && f.contendedWith.length > 0 && (
                  <span className="shrink-0 text-amber-500" title={`also written by ${f.contendedWith.join(', ')}`}>⚠</span>
                )}
                <span className="ml-auto shrink-0 text-[10px] text-neutral-600">
                  <span className="text-emerald-500">+{f.additions}</span>
                  {' '}
                  <span className="text-red-400">−{f.deletions}</span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto">
        <FileDiff paneId={paneId} file={current} mode={mode} />
      </div>
      </div>
    </div>
  );
}

/**
 * Copies the file as it is ON DISK, which is not what is drawn below it: the
 * hunks are this agent's own changelist, while the file may carry another
 * agent's later edits too. Hence "copy file", never "copy diff" — the wording
 * is the only thing telling a reviewer which of the two they just took.
 *
 * Keyed on the path by its caller, so switching files resets the note rather
 * than leaving "copied" under a different filename.
 */
function CopyFile({ paneId, file }: { paneId: string; file: DiffFile }): React.ReactElement {
  const { get } = useApi();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      const { content } = await get<FileContent>(
        `/api/agents/${paneId}/file?path=${encodeURIComponent(file.path)}`,
      );
      await navigator.clipboard.writeText(content);
      setError(null);
      setCopied(true);
    } catch (err) {
      // A failure has to say so in words: the label alone cannot distinguish
      // "did nothing" from "copied", and a silent no-op reads as the latter.
      setError((err as Error).message);
    }
  };

  return (
    <>
      {error && <span className="shrink-0 truncate text-[10px] text-red-400">{error}</span>}
      <button
        onClick={() => void copy()}
        className={`shrink-0 text-[11px] ${
          copied ? 'text-emerald-400' : 'text-neutral-500 hover:text-neutral-200'
        }`}
        title="Copy this file's current content on disk — not this changelist"
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </>
  );
}

function FileDiff(
  { paneId, file, mode }: { paneId: string; file: DiffFile; mode: 'unified' | 'split' },
): React.ReactElement {
  return (
    <section>
      <div className="sticky top-0 flex items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-2">
        {file.kind === 'create' && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">new</span>
        )}
        {file.kind === 'missing' && (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">gone</span>
        )}
        <code className="flex-1 truncate text-[12px] text-neutral-200">{file.relPath}</code>
        {file.contendedWith && file.contendedWith.length > 0 && (
          // Agents share one checkout, so this is a warning, not a lock.
          <span className="shrink-0 truncate text-[10px] text-amber-400">
            ⚠ also written by {file.contendedWith.join(', ')}
          </span>
        )}
        <span className="shrink-0 text-[11px]">
          <span className="text-emerald-400">+{file.additions}</span>
          <span className="ml-1 text-red-400">−{file.deletions}</span>
        </span>
        {/* Nothing on disk to copy for a file that is gone. */}
        {file.kind !== 'missing' && <CopyFile key={file.path} paneId={paneId} file={file} />}
      </div>

      {file.note ? (
        <p className="px-3 py-3 text-sm text-neutral-400">{file.note}</p>
      ) : (
        <div className="overflow-x-auto">
          {file.hunks.map((h, i) => (
            <div key={i}>
              <div className="bg-neutral-900/40 px-3 py-1 font-mono text-[11px] text-neutral-500">
                @@ −{h.oldStart},{h.oldLines} +{h.newStart},{h.newLines} @@
                {h.stale && (
                  <span
                    className="ml-2 text-amber-500"
                    title="The file no longer contains this change — something overwrote it"
                  >
                    ~ overwritten
                  </span>
                )}
              </div>
              {mode === 'unified'
                ? <UnifiedHunk hunk={h} language={file.language} />
                : <SplitHunk hunk={h} language={file.language} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const ROW = 'font-mono text-[12px] leading-[1.45] whitespace-pre';
/**
 * Split view wraps rather than clips. The two sides share a row, so a wrapped
 * line grows both cells and they stay paired — whereas clipping would silently
 * hide code, which is the one thing a review surface must never do.
 */
const ROW_WRAP = 'font-mono text-[12px] leading-[1.45] whitespace-pre-wrap break-words align-top';
const GUTTER = 'select-none px-2 text-right text-[11px] text-neutral-600 tabular-nums align-top';

const BG: Record<DiffLine['kind'], string> = {
  add: 'bg-emerald-500/10',
  del: 'bg-red-500/10',
  context: '',
};

/**
 * Both hunk renderers highlight one line at a time, because each line is its own
 * table cell.
 *
 * highlight.js emits spans that can cross line boundaries, so a whole-hunk
 * highlight cannot be split back into rows without breaking the markup. Per-line
 * means a construct spanning several lines (a block comment, a template literal)
 * may colour oddly — an acceptable trade for a local review surface, and it
 * never mangles the text itself.
 */
function UnifiedHunk({ hunk, language }: { hunk: DiffHunk; language: string | null }): React.ReactElement {
  return (
    <table className="w-full border-collapse">
      <tbody>
        {hunk.lines.map((l, i) => (
          <tr key={i} className={BG[l.kind]}>
            <td className={`${GUTTER} w-12`}>{l.oldLine ?? ''}</td>
            <td className={`${GUTTER} w-12`}>{l.newLine ?? ''}</td>
            <td className={`${ROW} w-4 select-none px-1 ${
              l.kind === 'add' ? 'text-emerald-400' : l.kind === 'del' ? 'text-red-400' : 'text-neutral-700'
            }`}>
              {l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}
            </td>
            <td
              className={`${ROW} w-full pr-3 text-neutral-300`}
              dangerouslySetInnerHTML={{ __html: highlight(l.text, language) || '&nbsp;' }}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Pair removals with additions so a modified line sits opposite its replacement.
 * Consecutive del/add runs are zipped; context lines appear on both sides.
 */
function splitRows(lines: DiffLine[]): Array<{ left?: DiffLine; right?: DiffLine }> {
  const rows: Array<{ left?: DiffLine; right?: DiffLine }> = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];

  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
      rows.push({ left: dels[i], right: adds[i] });
    }
    dels = [];
    adds = [];
  };

  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else { flush(); rows.push({ left: l, right: l }); }
  }
  flush();
  return rows;
}

/** Per line, for the reason given above `UnifiedHunk`. */
function SplitHunk({ hunk, language }: { hunk: DiffHunk; language: string | null }): React.ReactElement {
  const rows = useMemo(() => splitRows(hunk.lines), [hunk]);
  return (
    <table className="w-full table-fixed border-collapse">
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td className={`${GUTTER} w-12 ${r.left ? BG[r.left.kind] : ''}`}>{r.left?.oldLine ?? ''}</td>
            <td
              className={`${ROW_WRAP} w-[calc(50%-3rem)] pr-3 text-neutral-300 ${
                r.left ? BG[r.left.kind] : 'bg-neutral-900/30'
              }`}
              dangerouslySetInnerHTML={{ __html: r.left ? highlight(r.left.text, language) || '&nbsp;' : '&nbsp;' }}
            />
            <td className={`${GUTTER} w-12 border-l border-neutral-800 ${r.right ? BG[r.right.kind] : ''}`}>
              {r.right?.newLine ?? ''}
            </td>
            <td
              className={`${ROW_WRAP} w-[calc(50%-3rem)] pr-3 text-neutral-300 ${
                r.right ? BG[r.right.kind] : 'bg-neutral-900/30'
              }`}
              dangerouslySetInnerHTML={{ __html: r.right ? highlight(r.right.text, language) || '&nbsp;' : '&nbsp;' }}
            />
          </tr>
        ))}
      </tbody>
    </table>
  );
}
