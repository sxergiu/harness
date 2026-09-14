import { useEffect, useState } from 'react';
import { highlight } from './highlight.js';

/**
 * A block of code you can read and take: highlighted, labelled, with one copy
 * button. Used for every fenced block in the agent's prose and for the SQL a
 * tool call ran, so a query looks the same whether the agent printed it for you
 * to run or ran it itself.
 *
 * Highlighted whole, not per line — unlike the diff, nothing here splits the
 * markup back into rows, so a multi-line construct colours correctly.
 */
export function CodeBlock(
  { code, language }: { code: string; language: string | null },
): React.ReactElement {
  return (
    <div className="my-2 rounded border border-neutral-800 bg-neutral-900/50">
      <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1">
        <span className="flex-1 truncate text-[10px] uppercase tracking-wider text-neutral-500">
          {language ?? 'code'}
        </span>
        <Copy code={code} />
      </div>
      <pre className="max-h-80 overflow-auto px-2 py-1.5 font-mono text-[12px] leading-[1.45] text-neutral-300">
        <code dangerouslySetInnerHTML={{ __html: highlight(code, language) }} />
      </pre>
    </div>
  );
}

/**
 * Copies straight from the text already rendered above it. `Diff.tsx`'s
 * `CopyFile` fetches instead, because there the file on disk is deliberately
 * not what is drawn; here the two are the same string.
 */
function Copy({ code }: { code: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
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
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </>
  );
}
