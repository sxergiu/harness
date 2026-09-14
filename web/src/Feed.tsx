import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FeedEntry, FeedPage, FeedTurn } from '@harness/shared';
import { CodeBlock } from './CodeBlock.js';
import { Markdown } from './Markdown.js';
import { Spinner } from './Status.js';
import { useApi } from './useHarness.js';

/**
 * The structured feed. Prose reads as prose, every tool call is one line you
 * can open, and a subagent is one line you can open into its own feed.
 *
 * Paginated by turn rather than by bytes: a turn is the unit the work is
 * actually shaped in, and transcripts reach a megabyte.
 *
 * `jump` is a counter the prompt bar bumps to mean "take me to my last prompt".
 * The feed owns what that means, because it is the only thing here that knows
 * which entry the human last typed.
 */
export function Feed(
  { paneId, tick, jump }: { paneId: string; tick: number; jump: number },
): React.ReactElement {
  const { get } = useApi();
  const [turns, setTurns] = useState<FeedTurn[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  /**
   * Whether the first fetch has come back. Without it an empty feed is
   * indistinguishable from an unread one, and the panel claims there is no
   * transcript before it has looked. It never resets: a working agent refetches
   * several times a second, and a spinner on every refresh would only strobe.
   */
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // The newest turn refreshes live; older ones stay as loaded.
  useEffect(() => {
    let live = true;
    void get<FeedPage>(`/api/agents/${paneId}/feed`)
      .then((p) => {
        if (!live) return;
        setTotal(p.totalTurns);
        setTurns((prev) => merge(prev, p.turn));
        setFailed(null);
      })
      .catch((e: Error) => { if (live) setFailed(e.message); })
      .finally(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [get, paneId, tick]);

  const oldest = turns[0]?.index ?? total;
  const loadEarlier = async (): Promise<void> => {
    if (oldest <= 0 || loading) return;
    setLoading(true);
    try {
      const p = await get<FeedPage>(`/api/agents/${paneId}/feed?turn=${oldest - 1}`);
      setTurns((prev) => merge(prev, p.turn));
    } catch { /* leave what is already loaded */ } finally {
      setLoading(false);
    }
  };

  /**
   * Your last prompt: where the work you are reading was asked for. It is the
   * one anchor in a feed that is otherwise all machine output, so the jump puts
   * it at the top of the viewport and everything the agent did since below it.
   *
   * The flash is what tells you the jump happened at all. Landing on a prompt
   * already near the top scrolls by nothing, and without the flash that reads
   * as a dead button. It grows the text a size as well as washing the
   * background: a wash alone is easy to miss on a feed that is mostly grey on
   * black. Type size rather than a transform, because scaling a block this wide
   * pushes its right edge past the padding and the feed grows a scrollbar.
   */
  const view = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState(false);
  const latest = latestPrompt(turns);
  const latestKey = latest && `${latest.turn}:${latest.entry}`;

  /**
   * Room to scroll past the end, so the prompt can actually reach the top.
   * Scrolling alone cannot get it there when it is the NEWEST prompt: nothing
   * has been written under it yet, so the feed runs out of scroll with the
   * prompt still near the foot of the screen — measured 719px down an 811px
   * viewport, at maximum scroll. This is the shortfall and nothing more, so it
   * is a screenful the moment you send a prompt and zero once the agent has
   * filled that screen with work.
   *
   * The measurement is `end` minus `prompt`, both live rects, which is the real
   * content between them and is independent of the spacer's own height — so it
   * settles in one pass instead of chasing itself. A `ResizeObserver` drives it
   * rather than a render, because what invalidates it is content changing
   * height, which is not the same event as this component rendering: the window
   * resizing, a tool call being opened, markdown reflowing at a new width.
   */
  const end = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  /**
   * State, not a ref, so the observer attaches when the content box appears.
   * A ref plus a mount-time effect silently never observed anything: the first
   * render is the "reading transcript…" branch, where none of this exists yet.
   */
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const sc = view.current;
    if (!sc || !body) return;
    const measure = (): void => {
      if (!prompt.current || !end.current) return setRoom(0);
      const below = end.current.getBoundingClientRect().top
        - prompt.current.getBoundingClientRect().top;
      const need = Math.max(0, Math.round(sc.clientHeight - below));
      setRoom((r) => (Math.abs(r - need) > 1 ? need : r));
    };
    measure();
    // The spacer's own height changes neither box, so this cannot chase itself.
    const watch = new ResizeObserver(measure);
    watch.observe(sc);
    watch.observe(body);
    return () => watch.disconnect();
  }, [body]);

  /**
   * Instant, not smooth. `behavior: 'smooth'` never started here: sampled every
   * 100ms for a second after the call, the scroller had not moved a pixel,
   * while the same call without it lands immediately — a feed that refetches
   * several times a second does not hold a scroll animation still long enough
   * to run. The flash is what makes the move legible, which is its job anyway.
   *
   * A frame late, because the jump that matters most — a prompt you just sent —
   * arrives in the same pass that measures the room it needs. Scrolling now
   * would scroll against the old, too-short feed.
   */
  const spotlight = useCallback(() => {
    setFlash(true);
    requestAnimationFrame(() => prompt.current?.scrollIntoView({ block: 'start' }));
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1500);
    return () => clearTimeout(t);
  }, [flash]);

  // The button. 0 is the mount value and means nothing was asked for yet.
  useEffect(() => {
    if (jump > 0) spotlight();
  }, [jump, spotlight]);

  /**
   * And the same jump when a new prompt lands, which is how sending one follows
   * itself: the text reaches the transcript a beat after the send, so this
   * cannot fire from the click — it fires when the entry appears. A prompt
   * typed straight into the terminal moves the feed too, which is the same
   * event arriving by another door.
   */
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!latestKey) return;
    const first = seen.current === null;
    const moved = seen.current !== latestKey;
    seen.current = latestKey;
    if (moved && !first) spotlight();
  }, [latestKey, spotlight]);

  // Three different nothings, which the panel used to report as one.
  if (turns.length === 0) {
    if (!loaded) return <div className="p-4 text-xs"><Spinner label="reading transcript…" /></div>;
    if (failed) {
      return <p className="p-4 text-xs text-red-400">⚠ could not read the feed — {failed}</p>;
    }
    return (
      <p className="p-4 text-xs text-neutral-600">
        No transcript for this agent. It may not have started work yet, or the transcript may have
        been pruned.
      </p>
    );
  }

  return (
    // The feed scrolls itself, the way the diff tab owns its own height: the
    // spacer below is only meaningful to whatever the scrollport is.
    <div ref={view} className="h-full overflow-y-auto p-3 text-xs">
      {/* One box for all the content, so the observer above has one thing to
          watch: its height changing is exactly when the room needs remeasuring. */}
      <div ref={setBody}>
        {oldest > 0 && (
          <button
            onClick={() => void loadEarlier()}
            className="mb-3 flex w-full items-center justify-center rounded border border-neutral-800 py-1 text-neutral-500 hover:text-neutral-300"
          >
            {loading ? <Spinner label="loading…" /> : `↑ load turn ${oldest} of ${total}`}
          </button>
        )}
        {turns.map((t) => (
          <div key={t.index}>
            {t.entries.map((e, i) =>
              latest && t.index === latest.turn && i === latest.entry
                ? (
                  // Wrapped rather than flagged through `EntryRow`: which prompt
                  // is the latest is a fact about the feed, and `EntryRow` is
                  // shared with the subagents tab, where there is no such thing.
                  <div
                    key={i}
                    ref={prompt}
                    // `scroll-mt-4` is the landing gap: flush against the
                    // scrollport, the flash's wash and ring butt up against the
                    // tab bar and read as overlapping it.
                    className={`scroll-mt-4 rounded transition-all duration-300 ${
                      flash
                        ? 'bg-neutral-700/60 text-sm ring-1 ring-neutral-400/50'
                        : 'bg-transparent text-xs'
                    }`}
                  >
                    <EntryRow entry={e} />
                  </div>
                )
                : <EntryRow key={i} entry={e} />
            )}
          </div>
        ))}
      </div>
      <div ref={end} style={{ height: room }} />
    </div>
  );
}

/** The newest thing the human typed. Slash commands open turns too, and are not it. */
function latestPrompt(turns: FeedTurn[]): { turn: number; entry: number } | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const { index, entries } = turns[t];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].kind === 'user') return { turn: index, entry: i };
    }
  }
  return null;
}

function merge(prev: FeedTurn[], turn: FeedTurn | null): FeedTurn[] {
  if (!turn) return prev;
  const rest = prev.filter((t) => t.index !== turn.index);
  return [...rest, turn].sort((a, b) => a.index - b.index);
}

/**
 * Shared with the subagents tab, which renders a subagent's transcript with the
 * same vocabulary the parent's feed uses — a tool call must not look like one
 * thing here and another thing there.
 */
export function EntryRow({ entry }: { entry: FeedEntry }): React.ReactElement {
  // A row that ran SQL starts open: the query is the point of the row, and
  // hiding it behind a click would leave the 80-char clipped summary as the
  // only thing on screen. Read once, so closing one keeps it closed through the
  // refetches a working agent triggers several times a second.
  const [open, setOpen] = useState(entry.kind === 'tool' && entry.sql !== null);

  if (entry.kind === 'user') {
    return (
      <div className="my-3 border-l-2 border-neutral-600 pl-2 whitespace-pre-wrap text-neutral-300">
        {entry.text}
      </div>
    );
  }

  // A slash command, shown as what you typed rather than as its XML wrapper.
  if (entry.kind === 'command') {
    return (
      <div className="my-2 flex items-baseline gap-2">
        <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300">
          {entry.name}
        </span>
        {entry.args && <span className="truncate text-neutral-500">{entry.args}</span>}
      </div>
    );
  }

  // Claude Code's own plumbing — visible, but never mistakable for the human.
  if (entry.kind === 'system') {
    return (
      <div className="my-1 truncate pl-4 text-neutral-600" title={entry.text}>
        {entry.text.replace(/\s+/g, ' ')}
      </div>
    );
  }

  if (entry.kind === 'text') {
    return <div className="my-2 text-neutral-300"><Markdown source={entry.text} /></div>;
  }

  // A failed request stood in for the response. Shown as plain text — which is
  // what it used to be here — it read as something the agent chose to say.
  if (entry.kind === 'error') {
    return (
      <div className="my-2 flex items-start gap-2 rounded border border-red-900/60 bg-red-950/30 px-2 py-1 text-red-300">
        <span className="shrink-0">⚠</span>
        <span className="min-w-0 whitespace-pre-wrap">{entry.text}</span>
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    return (
      <Collapsible
        open={open}
        onToggle={() => setOpen(!open)}
        head={<span className="text-neutral-600 italic">thought</span>}
      >
        <pre className="whitespace-pre-wrap text-neutral-500">{entry.text}</pre>
      </Collapsible>
    );
  }

  // A marker, not a door. Reading a subagent happens in the subagents tab,
  // which is the only place that can also show the ones still running.
  if (entry.kind === 'agent') {
    return (
      <div className="my-0.5 flex items-center gap-1 pl-4">
        <span className="text-violet-400">{entry.agentType}</span>
        <span className="min-w-0 truncate text-neutral-600">{entry.description}</span>
        {entry.durationMs !== null && (
          <span className="shrink-0 text-neutral-700">{Math.round(entry.durationMs / 1000)}s</span>
        )}
        {entry.toolUseCount !== null && (
          <span className="shrink-0 text-neutral-700">· {entry.toolUseCount} tools</span>
        )}
      </div>
    );
  }

  return (
    <Collapsible
      open={open}
      onToggle={() => setOpen(!open)}
      head={
        <>
          <span className="text-neutral-400">{entry.name}</span>
          <span className="ml-2 truncate text-neutral-600">{entry.summary}</span>
          {entry.ok === false && <span className="ml-2 text-red-400">✗</span>}
          {entry.ok === true && <span className="ml-2 text-emerald-600">✓</span>}
          {/* No result yet: the call is still running, or waiting on you. */}
          {entry.ok === null && <span className="ml-2 animate-pulse text-amber-400">…</span>}
        </>
      }
    >
      {entry.sql !== null && <CodeBlock code={entry.sql} language="sql" />}
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-neutral-500">
        {entry.detail ?? '(no output recorded)'}
      </pre>
    </Collapsible>
  );
}

function Collapsible(
  { open, onToggle, head, children }: {
    open: boolean;
    onToggle: () => void;
    head: React.ReactNode;
    children: React.ReactNode;
  },
): React.ReactElement {
  return (
    <div className="my-0.5">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1 text-left hover:bg-neutral-900"
      >
        <span className="shrink-0 text-neutral-700">{open ? '▾' : '▸'}</span>
        {head}
      </button>
      {open && <div className="ml-4 my-1">{children}</div>}
    </div>
  );
}
