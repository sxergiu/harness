import { useEffect, useState } from 'react';
import { bashMode, type FeedEntry } from '@harness/shared';
import { highlight } from './highlight.js';
import { Spinner } from './Status.js';

type ShellRun = Extract<FeedEntry, { kind: 'shell' }>;

/**
 * What a block needs to run itself in an agent: the agent, its recorded runs,
 * and the two requests. Optional on every block, so prose with no agent behind
 * it — a subagent's, an aside's — renders the same block without the button.
 */
export interface ShellRunner {
  agent: string;
  working: boolean;
  /** Bumps on every board broadcast; the live tail is read on it, not on a timer. */
  tick: number;
  /** The index of the newest loaded turn. A run started now lands after it. */
  newest: number;
  /**
   * The turn the block was written in. Only a run after it is the block's own:
   * an earlier run of the same command printed what the code did BEFORE the
   * agent wrote this, and would read as this block's result.
   */
  since: number;
  run: (code: string, language: string | null) => Promise<void>;
  tail: (head: string) => Promise<string[] | null>;
  /** Every recorded run of exactly this command in the loaded feed, oldest first. */
  runs: (command: string) => { turn: number; run: ShellRun }[];
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
 * Given a `runner`, a shell block also runs, through the agent's own bash mode,
 * and shows what it printed underneath. `children` is the same slot for a run
 * already recorded, which is how the feed draws one.
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
        ? <Runnable code={code} language={language} command={command} runner={runner} />
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
 * ▶ run, a confirm, and then the output. The run goes to the agent as `! cmd`,
 * so it costs the agent a turn and executes whatever the agent wrote — which is
 * why one click only asks.
 *
 * While a run is pending the pane is the only place its output exists, so the
 * box tails it on every tick. Once the transcript records the run, the newest
 * recorded run of this command is what shows — so the output survives a reload,
 * and a run of the same command typed at the terminal shows here too.
 */
function Runnable(
  { code, language, command, runner }: {
    code: string;
    language: string | null;
    command: string;
    runner: ShellRunner;
  },
): React.ReactElement {
  const [confirm, setConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * The turn the run must land after, whether it was sent to a busy agent, and
   * the tail as it read BEFORE the send. A run queued behind a working agent is
   * not echoed yet, so the tail finds an older echo of the same command and
   * would present its output as this run's — the baseline is what is ignored.
   */
  const [pending, setPending] = useState<
    { after: number; queued: boolean; before: string } | null
  >(null);
  const [live, setLive] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runs = runner.runs(command).filter((r) => r.turn > runner.since);
  const latest = runs[runs.length - 1];
  const landed = pending !== null && latest !== undefined && latest.turn > pending.after
    && latest.run.output !== null;

  useEffect(() => {
    if (landed) { setPending(null); setLive(null); }
  }, [landed]);

  const head = command.split('\n')[0];
  const { tail, tick } = runner;
  useEffect(() => {
    if (!pending) return;
    let alive = true;
    const before = pending.before;
    void tail(head)
      .then((l) => { if (alive) setLive(JSON.stringify(l) === before ? null : l); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pending, tail, head, tick]);

  const go = async (): Promise<void> => {
    setConfirm(false);
    setError(null);
    setSending(true);
    try {
      const before = JSON.stringify(await runner.tail(head).catch(() => null));
      await runner.run(code, language);
      setPending({ after: runner.newest, queued: runner.working, before });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Head language={language} code={code}>
        {error && <span className="shrink-0 truncate text-[10px] text-red-400">{error}</span>}
        {confirm
          ? (
            <span className="flex shrink-0 items-center gap-2 text-[11px]">
              <span className="text-amber-200">run in {runner.agent}?</span>
              <button onClick={() => void go()} className="text-amber-200 hover:text-amber-100">
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
              disabled={pending !== null || sending}
              title="Run through the agent's bash mode (! cmd). The output enters its context and costs it a turn."
              className="shrink-0 text-[11px] text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
            >
              ▶ run
            </button>
          )}
      </Head>
      <Code code={code} language={language} />
      {pending
        ? (
          <div className="border-t border-neutral-800 px-2 py-1.5">
            {live && live.length > 0 && <Stream text={live.join('\n')} />}
            <div className="flex items-center gap-2 text-[11px]">
              <Spinner label={live ? 'running…' : pending.queued ? 'queued behind the agent’s turn…' : 'sent…'} />
              <button
                onClick={() => { setPending(null); setLive(null); }}
                title="Stop watching. The run itself is not stopped."
                className="ml-auto text-neutral-600 hover:text-neutral-300"
              >
                ×
              </button>
            </div>
          </div>
        )
        : latest && <ShellOutput output={latest.run.output} />}
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

function Stream({ text, error }: { text: string; error?: boolean }): React.ReactElement {
  return (
    <pre
      className={`max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-[1.45] ${
        error ? 'text-red-400' : 'text-neutral-400'
      }`}
    >
      {text}
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
