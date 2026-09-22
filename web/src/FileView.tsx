import { useEffect, useState } from 'react';
import type { FileContent } from '@harness/shared';
import type { FileViewer } from './fileRef.js';
import { highlight } from './highlight.js';
import { Markdown } from './Markdown.js';
import { Spinner } from './Status.js';
import { useApi } from './useHarness.js';

/**
 * A file the agent referenced, read from disk. Shares the right-hand split with
 * the fork panel and is shaped like it deliberately — the two are alternatives in
 * one slot, so they must not look like two different kinds of thing.
 *
 * Markdown renders as prose, because reading it is the point; everything else is
 * highlighted source. The `source` toggle exists for the one case where prose is
 * not what you want — checking exactly what a file says, rather than what it
 * looks like rendered.
 *
 * It does NOT refetch on the board's tick, unlike every other panel here. A file
 * has no new content arriving to justify it, and one reloading under a reader
 * fights the scroll; `↻` is how you ask for the current state.
 */
export function FileView(
  { paneId, path, viewer, onClose }: {
    paneId: string;
    path: string;
    viewer: FileViewer;
    onClose: () => void;
  },
): React.ReactElement {
  const { get } = useApi();
  const [file, setFile] = useState<FileContent | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  /** Bumped by `↻`, which is the only thing that refetches. */
  const [reload, setReload] = useState(0);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(null);
    void get<FileContent>(`/api/agents/${paneId}/file?path=${encodeURIComponent(path)}`)
      .then((f) => { if (live) setFile(f); })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, path, reload]);

  // A failed REFRESH keeps what is already on screen, the way the diff tab's
  // does: the content is real, just not current. It cannot be another file's —
  // the caller keys this panel on the path, so a different file is a fresh
  // mount rather than new content under an old heading.
  const markdown = file?.language === 'markdown';

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-neutral-800 text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-neutral-400" title={file?.path ?? path}>
          {file?.relPath ?? path}
        </span>
        {!file && !failed && <Spinner />}
        {markdown && (
          <button
            onClick={() => setRaw(!raw)}
            className={raw ? 'text-neutral-200' : 'text-neutral-500 hover:text-neutral-200'}
            title={raw ? 'Render this markdown' : 'Show the file as it is written'}
          >
            {raw ? 'rendered' : 'source'}
          </button>
        )}
        <button
          onClick={() => setReload((n) => n + 1)}
          className="text-neutral-500 hover:text-neutral-200"
          title="Read this file again — it is not refreshed on its own"
        >
          ↻
        </button>
        <button onClick={onClose} className="text-neutral-500 hover:text-neutral-200" title="Close">
          ×
        </button>
      </div>

      {failed && (
        <div className="shrink-0 bg-amber-900/30 px-2 py-1 text-amber-300">
          {file ? `showing the last read — refresh failed: ${failed}` : failed}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {file && (markdown && !raw
          // Threaded on, so a reference inside a document opens the next one.
          ? <div className="px-2 py-1.5"><Markdown source={file.content} viewer={viewer} /></div>
          : (
            // The panel's own `pre` rather than `CodeBlock`: that one caps at
            // `max-h-80` inside a panel the height of the window, and its header
            // would put a second language bar directly under this one.
            <pre className="px-2 py-1.5 font-mono text-[12px] leading-[1.45] text-neutral-300">
              <code
                dangerouslySetInnerHTML={{ __html: highlight(file.content, file.language) }}
              />
            </pre>
          ))}
      </div>
    </div>
  );
}
