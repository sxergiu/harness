import { useEffect, useRef, useState } from 'react';
import type { AgentRow, AsideView, BlockedView } from '@harness/shared';
import { DiffTab } from './Diff.js';
import { EntryRow, Feed } from './Feed.js';
import { ContextMeter, Spinner, StatusDot, Working } from './Status.js';
import { SubagentsTab } from './Subagents.js';
import { since, useApi } from './useHarness.js';

/**
 * The one-line height of the prompt field in px: 1px border + `py-1` + one
 * `text-xs` line. The shut usage dock is built to this same number, so the two
 * bars' top borders meet as one rule across the window rather than two at
 * different heights — which is why it is exported rather than written twice.
 *
 * `locked` pins the field here, and it is the floor a drag may not go under.
 */
export const PROMPT_ROW_H = 26;

/**
 * The ceiling, in vh, for all three ways the box can grow: a drag clamps to it,
 * typing stops growing at it, and a peek stops there too. More than this and
 * the prompt is no longer a bar under the feed, it is the view.
 */
const MAX_VH = 60;

/**
 * Opening width of the aside in px, the floor a drag may not go under, and the
 * ceiling in vw — past which the split has stopped being a feed with a question
 * beside it.
 */
const ASIDE_W = 420;
const ASIDE_MIN_W = 260;
const ASIDE_MAX_VW = 70;

/**
 * How the prompt box decides its height.
 *
 * `locked` and `free` are the two the button toggles between and the only two
 * worth remembering. `peek` is never stored: it exists only for as long as the
 * right button is held, so there is no way to be left parked in it.
 */
type PromptMode = 'locked' | 'free' | 'peek';

const MODE_KEY = 'harness.promptMode';

const MODE_HINT: Record<PromptMode, { icon: string; title: string }> = {
  locked: { icon: '⊤', title: 'Locked to one line — click to unlock, right-click and hold to peek' },
  free: { icon: '⇕', title: 'Drag the top border to resize — click to lock, right-click and hold to peek' },
  peek: { icon: '⊥', title: 'Opened out to fit your text, while held' },
};

/** Which command an assignment came from. One slot, so these are alternatives. */
type AssignKind = NonNullable<AgentRow['assignment']>['kind'];

/**
 * The two buttons, the one box they share, and the chip. Kept in one table so
 * the pair cannot drift into two different opinions about what setting an
 * assignment looks like — and exported for the board row's chip, which must
 * agree with this one on which colour means an investigation.
 */
export const ASSIGN: Record<AssignKind, {
  glyph: string;
  tone: string;
  title: string;
  placeholder: string;
  verb: string;
}> = {
  feature: {
    glyph: '⚑',
    // Lime rather than any status hue: sky is working and emerald is done, and
    // a chip wearing either read as a second opinion about the dot.
    tone: 'text-lime-400',
    title: '/feature — plan with a subagent, implement, review, file as changelists',
    placeholder: 'what to build — planned, implemented, reviewed, then filed as changelists',
    verb: 'build',
  },
  investigate: {
    glyph: '※',
    tone: 'text-fuchsia-400',
    title: '/investigate — read the code and discuss it; no edits, the output is the talk',
    placeholder: 'what to look into — read, report, propose options; nothing gets changed',
    verb: 'discuss',
  },
};

/**
 * Which command the shared box is currently typing into. One box, so these are
 * alternatives too — a goal and an assignment can both STAND at once, but only
 * one of them can be being written, and two boxes open meant two autofocused
 * fields stacked under the header.
 */
type Composing = AssignKind | 'goal';

/**
 * What the box says for whichever command opened it. Spread from `ASSIGN` so a
 * verb is written once: the goal is the third command of the same shape, not a
 * different kind of thing that happens to look like one.
 */
const FIELD: Record<Composing, { placeholder: string; verb: string }> = {
  ...ASSIGN,
  goal: {
    placeholder: 'condition to work toward, e.g. all tests in test/auth pass',
    verb: 'set',
  },
};

/**
 * The one field /goal, /feature and /investigate all type into: a sentence long
 * enough to be worth reading back, which a one-line input hides the end of.
 *
 * Dragged by the browser's own corner grip, unlike the prompt box. These sit
 * under the header and grow DOWNWARD — the direction the native grip pulls —
 * so there is nothing here for a handle of our own to fix, and this is the same
 * call the blocked pane makes for the same reason.
 *
 * Enter sends and shift-Enter breaks the line, as the prompt box does; a
 * multi-line command is typed into Claude Code and submitted as one prompt.
 */
function CommandField(
  { value, onChange, onSubmit, placeholder }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder: string;
  },
): React.ReactElement {
  return (
    <textarea
      autoFocus
      rows={1}
      style={{ minHeight: PROMPT_ROW_H, maxHeight: `${MAX_VH}vh` }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        onSubmit();
      }}
      placeholder={placeholder}
      className="min-w-0 flex-1 resize-y rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200"
    />
  );
}

/**
 * The agent's own name goes fuchsia while it is investigating, and only then —
 * so the investigations stand out of a column you are scanning. Shared with the
 * board row, which has to reach the same verdict about the same agent.
 */
export const nameTone = (assignment: AgentRow['assignment']): string =>
  assignment?.kind === 'investigate' ? 'text-fuchsia-300' : 'text-neutral-200';

/**
 * This view knows nothing about usage. The limits are an account-wide fact read
 * through whichever pane happens to be handy, so both the bars and the control
 * that fetches them live at the foot of the board column — an opener here would
 * have been a button in one agent's header acting on something that is not the
 * agent's.
 */
export function AgentView(
  { agent, tick }: { agent: AgentRow; tick: number },
): React.ReactElement {
  const { post } = useApi();
  const [tab, setTab] = useState<'feed' | 'diff' | 'subagents'>('feed');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** /clear destroys a conversation, so it does not fire on one click. */
  const [confirmClear, setConfirmClear] = useState(false);
  /**
   * The aside splits this view rather than replacing a tab, because the whole
   * point of it is reading the output and the answer at the same time. It is
   * not remembered: the view remounts on `paneId:sessionUuid`, so a `/clear`
   * shuts a panel whose fork is of a conversation that no longer exists.
   */
  const [asideOpen, setAsideOpen] = useState(false);
  const [asideW, setAsideW] = useState(ASIDE_W);
  /**
   * `/goal`, `/feature` and `/investigate` each take a sentence, and the two
   * assignments set the same slot — so all three share one box and which button
   * opened it is the whole difference. ONE piece of state rather than a flag
   * each: mutual exclusion is then a fact about the box, not a rule two handlers
   * have to keep remembering. What each set going shows as a chip below, and
   * where that has got to is the todo list, which the feed already renders.
   */
  const [composing, setComposing] = useState<Composing | null>(null);
  const [composeText, setComposeText] = useState('');
  /** Bumped to ask the feed to take you to your last prompt. */
  const [jump, setJump] = useState(0);
  /**
   * Height in px once the human has dragged for one, and null until then —
   * while it is null the field sizes itself to what you type.
   *
   * One value, not two modes: a drag is the human saying how tall it should be,
   * and from then on auto-sizing would be undoing that on every keystroke. It
   * lasts only as long as the mode does.
   */
  const [dragged, setDragged] = useState<number | null>(null);
  /**
   * The mode is the human's, not the agent's, so it outlives both this view and
   * the page. Only this one preference is stored, and a `max` written by a
   * crash mid-peek would still read back as `locked`.
   */
  const [mode, setMode] = useState<PromptMode>(
    () => (localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'locked'),
  );
  /** Right button held. Separate from `mode` so releasing restores what was. */
  const [peeking, setPeeking] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  /**
   * The mode is worth remembering; the height it was dragged to is not. So
   * unlocking starts the box at whatever the text needs, not at a drag you have
   * long since forgotten setting.
   */
  const remember = (next: PromptMode): void => {
    setMode(next);
    setDragged(null);
    localStorage.setItem(MODE_KEY, next);
  };

  /**
   * Opening an agent here focuses its pane in Herdr, so the terminal is always
   * showing whatever the browser is showing. This used to be a `terminal ↗`
   * button, which made the human do by hand the one thing the cockpit always
   * knows: which agent is being looked at.
   *
   * Keyed on the pane, and the view is already remounted per `paneId:session`,
   * so this fires once per agent you open rather than on every refresh. Failure
   * is silent on purpose — a pane that cannot be focused (it just exited) must
   * not put an error banner over a view that is otherwise fine.
   */
  useEffect(() => {
    if (!agent.live) return;
    void post(`/api/agents/${agent.paneId}/focus`).catch(() => {});
  }, [post, agent.paneId, agent.live]);

  const call = async (path: string, body?: unknown): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await post(path, body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text) return;
    setPrompt('');
    await call(`/api/agents/${agent.paneId}/prompt`, { text });
  };

  /**
   * Drags the prompt box taller by its top border: up is bigger, because up is
   * where the box grows.
   *
   * Listens on the window rather than the strip so the drag survives the pointer
   * outrunning an 8px target, and starts from the field's measured height so the
   * first drag continues from whatever the content had grown it to instead of
   * jumping.
   *
   * `pointercancel` ends it too: nothing follows one, so a drag left bound there
   * would keep resizing the box with no button held.
   */
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    const originY = e.clientY;
    const originH = field.current?.offsetHeight ?? 0;
    const ceiling = (window.innerHeight * MAX_VH) / 100;
    const move = (ev: PointerEvent): void =>
      setDragged(Math.max(PROMPT_ROW_H, Math.min(ceiling, originH + originY - ev.clientY)));
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  /**
   * The same drag as the prompt box's, turned on its side: the aside is dragged
   * by its left border, and left is where it grows. Bound to the window for the
   * same reason — the pointer outruns an 8px target, and a cancelled press is a
   * release that never arrives.
   */
  const startAsideResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    const originX = e.clientX;
    const originW = asideW;
    const ceiling = (window.innerWidth * ASIDE_MAX_VW) / 100;
    const move = (ev: PointerEvent): void =>
      setAsideW(Math.max(ASIDE_MIN_W, Math.min(ceiling, originW + originX - ev.clientX)));
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  /**
   * Right-press to peek at what is in the box, release to fall back to whatever
   * mode you were in. Watched on the window because a release anywhere has to end
   * the peek — the pointer need not still be over an 18px target after a hold, and
   * a cancelled press is a release that never arrives.
   */
  const startPeek = (e: React.PointerEvent): void => {
    if (e.button !== 2) return;
    setPeeking(true);
    const stop = (): void => {
      setPeeking(false);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const shown: PromptMode = peeking ? 'peek' : mode;
  /** What the mode alone asks for. Null hands the height back to the content. */
  const committed = mode === 'locked' ? PROMPT_ROW_H : dragged;
  /** Null hands the height back to the content, which `free` and a peek both do. */
  const height = shown === 'peek' ? null : committed;
  /**
   * A peek is content-sized, so it opens exactly as far as the hidden text needs
   * and no further — a whole 60vh to show a second line was the box taking over
   * the view to say very little. It is floored at the height it opened from,
   * because a peek that SHRANK a box you had dragged tall would be the opposite
   * of a look at what is in it.
   */
  const floor = shown === 'peek' ? committed ?? PROMPT_ROW_H : undefined;

  /**
   * Slash commands go down the same path as any other prompt — Claude Code
   * interprets the leading "/" itself, so nothing here needs to know what they
   * mean. Verified for /clear, /goal and /exit.
   */
  const command = (text: string): Promise<void> => call(`/api/agents/${agent.paneId}/prompt`, { text });

  /**
   * Opens the box on one command, or shuts it if that one already had it —
   * seeded with the standing value when it is this command's and blank
   * otherwise, since a sentence written for one of them sends nonsense to
   * another.
   */
  const open = (k: Composing): void => {
    setComposing(composing === k ? null : k);
    setComposeText(
      k === 'goal'
        ? agent.goal?.condition ?? ''
        : agent.assignment?.kind === k ? agent.assignment.text : '',
    );
  };

  /** Sends whichever command opened the box, and shuts it. */
  const compose = async (): Promise<void> => {
    const text = composeText.trim();
    if (!composing || !text) return;
    setComposeText('');
    setComposing(null);
    await command(`/${composing} ${text}`);
  };

  return (
    <div className="flex h-full flex-col text-xs">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <StatusDot agent={agent} />
        <span className={`truncate ${nameTone(agent.assignment)}`}>{agent.name}</span>
        <span className="text-neutral-600">{agent.repo}</span>
        <span className="text-neutral-500">{agent.status}</span>
        <span className="text-neutral-600">{since(agent.stateSince)}</span>
        {/* Room here for both numbers; the board row only has room for the share. */}
        <ContextMeter context={agent.context} tokens />
        {busy && <Spinner />}

        <div className="ml-auto flex gap-2">
          {agent.live && (
            <>
              {/* Neutral like every other control: the colour belongs to the
                  chip and the name, which say what the session IS. */}
              {(['feature', 'investigate'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => open(k)}
                  className={composing === k ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                  title={ASSIGN[k].title}
                >
                  {k}
                </button>
              ))}
              {/*
                Not a tab: an aside is a question ABOUT what the tabs are
                showing, so it opens beside them rather than over them.
              */}
              <button
                onClick={() => setAsideOpen(!asideOpen)}
                className={asideOpen ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                title="Ask about this without spending the agent's turn — forks the session, so its feed does not move"
              >
                fork
              </button>
              <button
                onClick={() => open('goal')}
                className={composing === 'goal' ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                title="Set a completion condition the agent works toward on its own"
              >
                goal
              </button>
              <button
                onClick={() => void call(`/api/agents/${agent.paneId}/interrupt`)}
                className="text-neutral-400 hover:text-neutral-200"
              >
                stop
              </button>
              {/*
                No `exit` beside this. Ending an agent lives on its board row,
                where `✕` closes the tab and takes the pane with it — one way
                out rather than two that differ in what they leave behind.
              */}
              <button
                onClick={() => setConfirmClear(true)}
                className="text-neutral-400 hover:text-neutral-200"
                title="/clear — start a new conversation, discarding this one"
              >
                clear
              </button>
            </>
          )}
        </div>
      </header>

      {agent.title && <div className="truncate px-3 py-1 text-neutral-600">{agent.title}</div>}

      {/*
        Two different failures, deliberately not one banner. Amber is the
        HARNESS failing to do what you asked; red is CLAUDE CODE failing, which
        the harness only observed and cannot retry for you.
      */}
      {error && <div className="bg-amber-900/30 px-3 py-1 text-amber-300">{error}</div>}
      {agent.error && (
        <div className="flex items-baseline gap-2 border-b border-red-900/60 bg-red-950/30 px-3 py-1.5">
          <span className="shrink-0 text-red-400">⚠</span>
          <span className="min-w-0 flex-1 text-red-300">{agent.error}</span>
          <span className="shrink-0 text-neutral-600">
            the agent is stopped — retry from the prompt below, or open the terminal
          </span>
        </div>
      )}

      {/*
        Top-aligned, unlike the prompt bar's `items-end`: this box grows DOWN
        when dragged, so the buttons stay where they were rather than following
        the bottom edge away.
      */}
      {composing && (
        <div className="flex items-start gap-2 border-b border-neutral-800 px-3 py-2">
          <CommandField
            value={composeText}
            onChange={setComposeText}
            onSubmit={() => void compose()}
            placeholder={FIELD[composing].placeholder}
          />
          <button
            disabled={!composeText.trim()}
            onClick={() => void compose()}
            className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
          >
            {FIELD[composing].verb}
          </button>
          {/* Only a goal can be cleared without being replaced: the two
              assignments share one slot, so each is dropped by setting the
              other or by /clear. */}
          {composing === 'goal' && agent.goal && (
            <button
              onClick={() => { void command('/goal clear'); setComposing(null); }}
              className="px-2 py-1 text-neutral-400 hover:text-neutral-200"
            >
              clear goal
            </button>
          )}
          <button onClick={() => setComposing(null)} className="px-2 py-1 text-neutral-500">
            cancel
          </button>
        </div>
      )}

      {/*
        Hidden while its own box is open, exactly as the goal chip is: the box
        is where you are changing it, and the chip would be saying what it is
        about to stop being. The goal box leaves it alone — that one is not
        changing this.
      */}
      {agent.assignment && (!composing || composing === 'goal') && (
        <div className="flex items-baseline gap-2 border-b border-neutral-800 px-3 py-1">
          <span className={ASSIGN[agent.assignment.kind].tone}>{ASSIGN[agent.assignment.kind].glyph}</span>
          <span className="truncate text-neutral-400">{agent.assignment.text}</span>
          {/*
            Rides the chip, as the goal's "met" does, rather than joining the
            banners below — those two mean the agent is STOPPED, and this one
            means it carried on doing something it was asked not to. Nothing
            stopped it; saying so is all the harness can do.
          */}
          {agent.assignment.kind === 'investigate' && agent.assignment.filesSince > 0 && (
            <span
              className="ml-auto shrink-0 text-amber-400"
              title="an investigation is not meant to change files — nothing prevented it"
            >
              ⚠ {agent.assignment.filesSince} file
              {agent.assignment.filesSince === 1 ? '' : 's'} written
            </span>
          )}
        </div>
      )}

      {agent.goal && composing !== 'goal' && (
        <div className="flex items-baseline gap-2 border-b border-neutral-800 px-3 py-1">
          <span className={agent.goal.met ? 'text-emerald-400' : 'text-violet-400'}>◎</span>
          <span className="truncate text-neutral-400">{agent.goal.condition}</span>
          {agent.goal.met && <span className="shrink-0 text-emerald-600">met</span>}
        </div>
      )}

      {confirmClear && (
        <div className="flex items-center gap-3 border-b border-amber-800/60 bg-amber-950/20 px-3 py-2">
          <span className="text-amber-200">
            Discard this conversation and start fresh? Any active goal is dropped too.
          </span>
          <button
            onClick={() => { void command('/clear'); setConfirmClear(false); }}
            className="ml-auto rounded border border-amber-700/60 px-2 py-0.5 text-amber-200 hover:bg-amber-900/40"
          >
            /clear
          </button>
          <button onClick={() => setConfirmClear(false)} className="text-neutral-400 hover:text-neutral-200">
            cancel
          </button>
        </div>
      )}

      {agent.status === 'blocked' && agent.live && <Blocked paneId={agent.paneId} />}

      <nav className="flex gap-3 border-b border-neutral-800 px-3">
        {(['feed', 'diff', 'subagents'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 py-1 ${
              tab === t ? 'border-neutral-300 text-neutral-200' : 'border-transparent text-neutral-500'
            }`}
          >
            {t}
            {t === 'diff' && agent.fileCount > 0 && (
              <span className="ml-1 text-neutral-600">·{agent.fileCount}</span>
            )}
          </button>
        ))}
      </nav>

      {/*
        The aside splits this row, not the whole view: the prompt bar below
        stays full width and stays the PARENT's, which is the one confusion a
        second input in the same view could cause. Because it is beside the tab
        rather than inside one, a question about the diff is asked the same way
        as a question about the feed.
      */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Each tab owns its own height: the diff scrolls its tree and its hunks
            apart, and the feed needs its scrollport to be its own element. */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {tab === 'feed' && <Feed paneId={agent.paneId} tick={tick} jump={jump} />}
          {tab === 'diff' && <DiffTab paneId={agent.paneId} tick={tick} />}
          {tab === 'subagents' && <SubagentsTab paneId={agent.paneId} tick={tick} />}
        </div>
        {asideOpen && (
          <>
            <div
              onPointerDown={startAsideResize}
              title="Drag to resize"
              className="w-1 shrink-0 cursor-ew-resize bg-neutral-800 hover:bg-neutral-600"
            />
            <div style={{ width: asideW }} className="min-w-0 shrink-0 overflow-hidden">
              <AsidePanel paneId={agent.paneId} tick={tick} onClose={() => setAsideOpen(false)} />
            </div>
          </>
        )}
      </div>

      {/*
        Pinned rather than appended to the feed: the feed scrolls and this is
        the answer to "is it still going?", which must not require scrolling.
        `stateSince` is how long it has been working, not how long it has run.
      */}
      {agent.live && agent.status === 'working' && !agent.error && (
        <div className="flex items-center gap-2 border-t border-neutral-800 px-3 py-1">
          <Working agent={agent} />
          <span className="ml-auto shrink-0 text-neutral-600">{since(agent.stateSince)}</span>
        </div>
      )}

      {agent.live && (
        <div className="relative flex items-end gap-2 border-t border-neutral-800 p-2">
          {/*
            The whole section resizes, dragged by its own top border — the edge
            that moves. A textarea's native corner grip is the wrong control
            here: it sits at the bottom right of a box already at the bottom of
            the window, so growing the field means dragging away from the
            direction it grows.

            Present only where it does something. The pinned modes have a height
            of their own, so a strip that took a drag there would either fight
            them or lie.
          */}
          {shown === 'free' && (
            <div
              onPointerDown={startResize}
              title="Drag to resize"
              className="absolute inset-x-0 -top-1 h-2 cursor-ns-resize"
            />
          )}
          {/*
            Only on the feed, because it acts on the feed. On the diff or the
            subagents tab the same click would have to change tabs first, which
            is one button doing two things.
          */}
          {tab === 'feed' && (
            <button
              onClick={() => setJump((n) => n + 1)}
              title="Jump to your last prompt"
              className="px-1 py-1 text-neutral-500 hover:text-neutral-200"
            >
              ⤒
            </button>
          )}
          {/*
            Unlike the jump beside it, this one is on every tab: it governs the
            input, which is on every tab too.
          */}
          <button
            onClick={() => remember(mode === 'locked' ? 'free' : 'locked')}
            onPointerDown={startPeek}
            onContextMenu={(e) => e.preventDefault()}
            title={MODE_HINT[shown].title}
            className={`px-1 py-1 hover:text-neutral-200 ${
              shown === 'free' ? 'text-neutral-300' : 'text-neutral-500'
            }`}
          >
            {MODE_HINT[shown].icon}
          </button>
          {/*
            Unlocked and not yet dragged — and while a peek is held —
            `field-sizing: content` grows the field to its text: the browser's
            measurement, and exact, where measuring a scroll height ourselves
            would be a copy of it that runs a frame late.

            Enter still sends, so a newline needs shift. Verified on a live agent
            that this is worth offering: `agent.prompt` types a multi-line text
            into Claude Code's box and submits it as ONE prompt — it does not
            split at the first newline.

            Locked is one line that runs off the end, exactly like the `input`
            this replaced: it does not wrap, and it hides the overflow rather
            than scrolling it, because in a box one line tall the scrollbar is
            taller than the line it scrolls. Wrapping without the scrollbar
            would be worse than either — text simply gone below the edge. The
            caret is still followed, so typing past the end tracks it.
          */}
          <textarea
            ref={field}
            rows={1}
            style={{
              maxHeight: `${MAX_VH}vh`,
              ...(height === null ? { minHeight: floor } : { height }),
            }}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              // Outgrowing the one line unlocks the box, since locked from here
              // on would be hiding what you just typed — sideways for a long
              // line, below the edge for a second one. Asked of the element,
              // which already holds the new value and knows the width it has to
              // fit in. Not remembered: the mode you chose by hand is still the
              // one the next view starts in.
              const box = e.target;
              if (box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight) {
                setMode('free');
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder="prompt this agent…  ⏎ sends, ⇧⏎ newline"
            className={`flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200 ${
              height === null ? 'field-sizing-content' : ''
            } ${shown === 'locked' ? 'overflow-hidden whitespace-pre' : ''}`}
          />
          <button
            disabled={busy || !prompt.trim()}
            onClick={() => void send()}
            className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
          >
            {busy ? 'sending…' : 'send'}
          </button>
        </div>
      )}

    </div>
  );
}

/**
 * A side conversation forked off this agent's session, so a question about what
 * it just said costs it nothing: the fork gets its own transcript and the
 * agent's feed does not move.
 *
 * Only the exchange since the fork is shown. The conversation it was forked
 * with is the feed to the left of this panel, and rendering it twice on one
 * screen would be the whole point of the split thrown away.
 *
 * There is no start button. The panel opens empty and the first question forks
 * the session — which is slow the first time, and says so.
 */
function AsidePanel(
  { paneId, tick, onClose }: { paneId: string; tick: number; onClose: () => void },
): React.ReactElement {
  const { get, post } = useApi();
  const [view, setView] = useState<AsideView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  /** Bumped to refetch straight after acting, rather than waiting for a tick. */
  const [reload, setReload] = useState(0);

  // A successful poll is not evidence that your last action worked, so it does
  // not clear the banner — an action's own start does. Otherwise the refetch
  // these actions trigger would wipe their error before it could be read.
  useEffect(() => {
    let live = true;
    void get<AsideView>(`/api/agents/${paneId}/aside`)
      .then((v) => { if (live) setView(v); })
      .catch((e: Error) => { if (live) setFailed(e.message); });
    return () => { live = false; };
  }, [get, paneId, tick, reload]);

  const ask = async (): Promise<void> => {
    const question = text.trim();
    // The button is disabled while busy and the Enter key is not, and the first
    // question takes ~10s — long enough to type a second and fork twice.
    if (!question || busy) return;
    setText('');
    setBusy(true);
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/aside`, { text: question });
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };

  /**
   * Ends the forked agent. `keepOpen` is the difference between reforking and
   * shutting the panel: with no aside left, the next question takes a fresh
   * copy of wherever the parent has got to since.
   *
   * Nothing is torn down until the close actually returns. Shutting the panel
   * in a `finally` would take the error banner with it while the fork was still
   * running, and there would be nothing left on screen to say so.
   */
  const drop = async (keepOpen: boolean): Promise<void> => {
    setBusy(true);
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/aside/close`);
      setView(null);
      if (!keepOpen) onClose();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };

  const open = view?.paneId != null;

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-neutral-800 text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        {view?.status && <StatusDot agent={{ status: view.status, error: null }} />}
        <span className="text-neutral-400">fork</span>
        {busy && <Spinner />}
        <div className="ml-auto flex gap-2">
          {open && (
            <button
              onClick={() => void drop(true)}
              className="text-neutral-500 hover:text-neutral-200"
              title="Drop this fork — the next question takes a fresh copy of the agent's context"
            >
              refork
            </button>
          )}
          <button
            onClick={() => void (open ? drop(false) : onClose())}
            className="text-neutral-500 hover:text-neutral-200"
            title={open ? 'Close the fork and end its agent' : 'Close'}
          >
            ×
          </button>
        </div>
      </div>

      {/*
        The aside is told to change nothing and nothing enforces it, so the only
        thing the harness can do is say what it wrote. Same wording and tone as
        an investigation's, because it is the same fact.
      */}
      {view && view.filesWritten > 0 && (
        <div
          className="shrink-0 border-b border-neutral-800 px-2 py-1 text-amber-400"
          title="a fork is not meant to change files — nothing prevented it"
        >
          ⚠ {view.filesWritten} file{view.filesWritten === 1 ? '' : 's'} written
        </div>
      )}

      {failed && <div className="shrink-0 bg-amber-900/30 px-2 py-1 text-amber-300">{failed}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {view?.entries.length
          ? view.entries.map((entry, i) => <EntryRow key={i} entry={entry} />)
          : (
            <p className="py-2 text-neutral-600">
              {busy && !open
                ? 'forking the session — a tab, a launch and a copy of the context, about 10s'
                : 'Ask about anything on the left. The question runs in a fork of this agent’s session, so its feed does not move.'}
            </p>
          )}
      </div>

      <div className="flex shrink-0 gap-2 border-t border-neutral-800 p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          placeholder="ask about this…"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200"
        />
        <button
          disabled={busy || !text.trim()}
          onClick={() => void ask()}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
        >
          ask
        </button>
      </div>
    </div>
  );
}

/**
 * Four digits, not three: prompts routinely offer a fourth option, and beyond
 * that the arrows reach any row whatever its number.
 *
 * The arrows are what make a multi-select answerable at all. Measured live on a
 * `multiSelect` AskUserQuestion: a digit ticks a box and **Enter TOGGLES the
 * highlighted row** — pressed after ticking Apples it un-ticked it — so digits
 * and Enter alone can never submit, however long you press them. Submit is a
 * row of its own below the options (`↓`) and a tab beside them (`→`), and Enter
 * on either opens an ordinary numbered confirm the digits then handle. A
 * single-select has no such row and Enter does submit it, which is why this
 * only ever failed sometimes.
 *
 * Arrows rather than a `submit` button that sends `right enter`: that would be
 * parsing the prompt by assumption, which is the one thing this panel does not
 * do. Which keys reach submit is the prompt's business.
 */
const BLOCKED_KEYS: ReadonlyArray<readonly [label: string, key: string]> = [
  ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'],
  ['↑', 'up'], ['↓', 'down'], ['←', 'left'], ['→', 'right'],
  ['enter', 'enter'], ['escape', 'escape'],
];

/**
 * The single place raw terminal text appears. We do not parse permission
 * prompts, so this shows the pane verbatim and offers plain keystrokes —
 * optimistic by design. After sending we re-read the pane so you can see what
 * actually happened rather than what we assumed would.
 */
function Blocked({ paneId }: { paneId: string }): React.ReactElement {
  const { get, post } = useApi();
  const [text, setText] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [reply, setReply] = useState('');
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void get<BlockedView>(`/api/agents/${paneId}/blocked`)
      .then((v) => { if (live) setText(v.text); })
      .catch((e: Error) => { if (live) setText(`could not read pane: ${e.message}`); });
    return () => { live = false; };
  }, [get, paneId, reload]);

  const key = async (k: string): Promise<void> => {
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/keys`, { keys: [k] });
    } catch { /* the re-read below will show that nothing changed */ }
    setTimeout(() => setReload((n) => n + 1), 400);
  };

  /**
   * The other kind of answer. Some prompts do not want a number at all — "tell
   * Claude what to do differently" opens a text box, and pressing 1..4 at it
   * types a digit. Same optimism as the keys: typed, submitted, then re-read.
   *
   * The box is cleared only once the server says the words landed. A selection
   * dialog swallows text and leaves no trace of it (see `sendText`), and the
   * refusal that comes back is about a sentence the human wrote — asking them
   * to type it again, after we dropped it, is the one thing worth avoiding
   * here. So it stays put with the reason above it, and the row they need to
   * highlight first is an arrow key away.
   */
  const answer = async (): Promise<void> => {
    const value = reply.trim();
    if (!value) return;
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/text`, { text: value });
      setReply('');
    } catch (e) {
      setFailed((e as Error).message);
    }
    setTimeout(() => setReload((n) => n + 1), 400);
  };

  return (
    <div className="border-b border-amber-800/60 bg-amber-950/20 p-2">
      {/*
        Native `resize-y` rather than a drag handle of our own: the pane text is
        the one thing here whose useful height is unknowable — a yes/no prompt
        needs three lines, a plan or a long diff needs the screen — so the human
        drags the corner and the browser owns the interaction.
      */}
      <pre className="mb-2 h-64 resize-y overflow-auto whitespace-pre-wrap text-[11px] text-amber-100/80">
        {text ?? 'reading pane…'}
      </pre>
      <div className="flex gap-1">
        {BLOCKED_KEYS.map(([label, k]) => (
          <button
            key={k}
            onClick={() => void key(k)}
            className="rounded border border-amber-700/60 px-2 py-0.5 text-amber-200 hover:bg-amber-900/40"
          >
            {label}
          </button>
        ))}
        <button
          onClick={() => setReload((n) => n + 1)}
          className="ml-auto text-neutral-500 hover:text-neutral-300"
        >
          refresh
        </button>
      </div>

      {failed && <p className="mt-2 rounded bg-amber-900/40 px-2 py-1 text-amber-200">{failed}</p>}

      <input
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void answer(); }}
        placeholder="…or type an answer — for prompts that ask for words, not a number"
        className="mt-2 w-full rounded border border-amber-800/60 bg-amber-950/30 px-2 py-1 text-amber-100 placeholder:text-amber-200/40"
      />
    </div>
  );
}
