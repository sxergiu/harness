import { useEffect, useState } from 'react';
import { bashMode, type FeedEntry } from '@harness/shared';
import { highlight } from './highlight.js';
import { Linkified } from './links.js';

type ShellRun = Extract<FeedEntry, { kind: 'shell' }>;

/**
 * What a block needs to run itself: where it runs, for the confirm, and the
 * hand-off. Optional on every block, so prose with no agent behind it — a
 * subagent's, an aside's — renders the same block without the button.
 */
export interface ShellRunner {
  target: string;
  run: (code: string, language: string | null) => void;
}

/**
 * A block of code you can read and take: highlighted, labelled, with one copy
 * button. Used for every fenced block in the agent's prose and for the SQL a
 * tool call ran, so a query looks the same whether the agent printed it for you
 * to run or ran it itself.
 *
 * Highlighted whole, not per line — unlike the diff, nothing here splits the
 * markup back into rows, so a multi-line construct colours correctly.
 *
 * Given a `runner`, a shell block also runs, in the agent's run fork, whose
 * panel shows what it printed. `children` is the slot for a run already
 * recorded, which is how a feed draws one.
 */
export function CodeBlock(
  { code, language, runner, children }: {
    code: string;
    language: string | null;
    runner?: ShellRunner;
    children?: React.ReactNode;
  },
): React.ReactElement {
  const command = runner ? bashMode(code, language) : null;
  return (
    <div className="my-2 rounded border border-neutral-800 bg-neutral-900/50">
      {runner && command
        ? <Runnable code={code} language={language} runner={runner} />
        : (
          <>
            <Head language={language} code={code} />
            <Code code={code} language={language} />
          </>
        )}
      {children}
    </div>
  );
}

function Head(
  { language, code, children }: { language: string | null; code: string; children?: React.ReactNode },
): React.ReactElement {
  return (
    <div className="flex items-center gap-2 border-b border-neutral-800 px-2 py-1">
      <span className="flex-1 truncate text-[10px] uppercase tracking-wider text-neutral-500">
        {language ?? 'code'}
      </span>
      {children}
      <Copy code={code} />
    </div>
  );
}

function Code({ code, language }: { code: string; language: string | null }): React.ReactElement {
  return (
    <pre className="max-h-80 overflow-auto px-2 py-1.5 font-mono text-[12px] leading-[1.45] text-neutral-300">
      <code dangerouslySetInnerHTML={{ __html: highlight(code, language) }} />
    </pre>
  );
}

/**
 * ▶ run and a confirm. The run goes to the run fork as `! cmd` and executes
 * whatever the agent wrote, which is why one click only asks. Its output and the
 * fork's reading of it are in the run panel, so all the block keeps is that it
 * was sent — and ▶ stays live, because running a block again is ordinary.
 */
function Runnable(
  { code, language, runner }: { code: string; language: string | null; runner: ShellRunner },
): React.ReactElement {
  const [confirm, setConfirm] = useState(false);
  const [sent, setSent] = useState(false);

  return (
    <>
      <Head language={language} code={code}>
        {sent && !confirm && <span className="shrink-0 text-[10px] text-neutral-600">↳ sent to runs</span>}
        {confirm
          ? (
            <span className="flex shrink-0 items-center gap-2 text-[11px]">
              <span className="text-amber-200">run in {runner.target}?</span>
              <button
                onClick={() => { setConfirm(false); setSent(true); runner.run(code, language); }}
                className="text-amber-200 hover:text-amber-100"
              >
                yes
              </button>
              <button onClick={() => setConfirm(false)} className="text-neutral-500 hover:text-neutral-200">
                no
              </button>
            </span>
          )
          : (
            <button
              onClick={() => setConfirm(true)}
              title="Runs in a fork of this session (! cmd), which explains the result. The agent never sees it."
              className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-200"
            >
              ▶ run
            </button>
          )}
      </Head>
      <Code code={code} language={language} />
    </>
  );
}

/** What a recorded run printed, under the block that shows its command. */
export function ShellOutput(
  { output }: { output: ShellRun['output'] },
): React.ReactElement {
  return (
    <div className="border-t border-neutral-800 px-2 py-1.5">
      {output === null
        ? <span className="text-[11px] text-neutral-600">no output recorded</span>
        : !output.stdout && !output.stderr
          ? <span className="text-[11px] text-neutral-600">(no output)</span>
          : (
            <>
              {output.stdout && <Stream text={output.stdout} />}
              {output.stderr && <Stream text={output.stderr} error />}
            </>
          )}
    </div>
  );
}

export function Stream({ text, error }: { text: string; error?: boolean }): React.ReactElement {
  return (
    <pre
      className={`max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.45] ${
        error ? 'text-red-400' : 'text-neutral-400'
      }`}
    >
      <Linkified text={text} />
    </pre>
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
