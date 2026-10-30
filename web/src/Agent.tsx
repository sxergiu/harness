import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EFFORTS, MODELS, bashMode,
  type AgentRow, type AsideView, type BlockedView, type EffortLevel, type FeedEntry, type ModelAlias,
  type ShellTail,
} from '@harness/shared';
import { Stream, type ShellRunner } from './CodeBlock.js';
import { useSelectionCopy } from './copyOnSelect.js';
import { DiffTab } from './Diff.js';
import { EntryRow, Feed, Spotlit, usePromptJump } from './Feed.js';
import type { FileViewer } from './fileRef.js';
import { FileView } from './FileView.js';
import { type Panels, panelsOf, rememberPanels } from './panels.js';
import { ContextMeter, Spinner, StatusDot, Working } from './Status.js';
import { SubagentsTab } from './Subagents.js';
import { SummaryTab } from './Summary.js';
import { modelLabel, modelReading, since, useApi } from './useHarness.js';

/**
 * The one-line height of the prompt field in px: 1px border + `py-1` + one
 * `text-xs` line. The shut usage dock is built to this same number, so the two
 * bars' top borders meet as one rule across the window rather than two at
 * different heights — which is why it is exported rather than written twice.
 */
export const PROMPT_ROW_H = 26;

/**
 * The ceiling, in vh, a field stops growing with its text at; past it the text
 * scrolls. More than this and the prompt is no longer a bar under the feed, it
 * is the view.
 */
const MAX_VH = 60;

/**
 * Opening width of a right-hand column in px, the floor a drag may not go under,
 * and the ceiling in vw for the columns TOGETHER — past which the view has
 * stopped being a feed with something beside it.
 */
const SPLIT_W = 420;
const SPLIT_MIN_W = 260;
const SPLIT_MAX_VW = 70;

/**
 * The widths you dragged, kept outside the view for `drafts`' reason: it
 * remounts on every agent switch and `/clear`, and a column that snapped back
 * each time would have to be dragged again every time. In memory only.
 */
const widths: Record<Column, number> = { fork: SPLIT_W, files: SPLIT_W };

const MAX_FILES = 4;

/**
 * Unsent prompts by pane, kept outside the view because the view remounts
 * whenever the session id changes — on `/clear`, and on every fresh launch,
 * whose row is on the board ~1.1s before its session id is. A draft held in the
 * view's own state went with the old mount.
 *
 * In `sessionStorage` rather than memory, so a reload keeps them too — and a dev
 * cockpit reloads itself whenever an agent edits a module this one exports
 * from. Guarded like the theme: storage that throws costs a draft its survival,
 * never the typing.
 */
const DRAFT_KEY = 'harness.draft.';
const drafts = {
  get(paneId: string): string | undefined {
    try {
      return sessionStorage.getItem(DRAFT_KEY + paneId) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(paneId: string, text: string): void {
    try {
      sessionStorage.setItem(DRAFT_KEY + paneId, text);
    } catch { /* the draft lives in the box until the next remount */ }
  },
  delete(paneId: string): void {
    try {
      sessionStorage.removeItem(DRAFT_KEY + paneId);
    } catch { /* nothing to drop */ }
  },
};

/**
 * Drops every draft whose pane has left the board. Herdr recycles pane ids, so
 * a draft kept past its pane would turn up in the box of whichever agent
 * inherits the id — and until then it sits where no box can show it.
 */
export function pruneDrafts(onBoard: ReadonlySet<string>): void {
  try {
    for (const key of Object.keys(sessionStorage)) {
      const paneId = key.slice(DRAFT_KEY.length);
      if (key.startsWith(DRAFT_KEY) && !onBoard.has(paneId)) drafts.delete(paneId);
    }
  } catch { /* unreadable storage holds nothing to prune */ }
}

const STARTING_HINT = 'the agent is starting — the box unlocks when it can take a prompt';

/**
 * The agent pane from the click on a space's `+` until the start returns, ~4s.
 * Without it the previous agent stays on screen, so text typed in that wait
 * goes into the box of an agent it was never meant for. The locked box is here
 * so the lock is visible where the typing would have gone.
 */
export function StartingView({ where }: { where: string }): React.ReactElement {
  return (
    <div className="flex h-full flex-col text-xs">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <Spinner label={`starting an agent in ${where}…`} />
      </header>
      <div className="flex-1" />
      <div className="flex items-end gap-2 border-t border-neutral-800 p-2">
        <textarea
          readOnly
          rows={1}
          style={{ minHeight: PROMPT_ROW_H }}
          placeholder={STARTING_HINT}
          className="min-w-0 flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-500"
        />
      </div>
    </div>
  );
}

/** The columns beside the tabs, in the order they sit left to right. */
type Column = 'fork' | 'files';

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
 * It grows with its text the way the prompt box does — `field-sizing:
 * content`, the browser's own measurement — so a sentence that wraps opens a
 * second line the moment it does, up to the same `MAX_VH` ceiling.
 *
 * Also dragged by the browser's own corner grip, which the prompt box is not.
 * These sit under the header and grow DOWNWARD — the direction the native grip
 * pulls — and this is the same call the blocked pane makes for the same reason.
 * A drag pins the height it was dragged to.
 *
 * Enter sends and shift-Enter breaks the line, as the prompt box does; a
 * multi-line command is typed into Claude Code and submitted as one prompt.
 */
function CommandField(
  { value, onChange, onSubmit, placeholder, readOnly }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder: string;
    readOnly: boolean;
  },
): React.ReactElement {
  return (
    <textarea
      autoFocus
      rows={1}
      style={{ minHeight: PROMPT_ROW_H, maxHeight: `${MAX_VH}vh` }}
      readOnly={readOnly}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.shiftKey) return;
        e.preventDefault();
        onSubmit();
      }}
      placeholder={placeholder}
      className="field-sizing-content min-w-0 flex-1 resize-y rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200"
    />
  );
}

/**
 * What this agent is running on, and the aliases it can be asked to run on
 * instead. A fact you can also change, so it sits with the facts on the left of
 * the header rather than among the verbs on the right.
 *
 * **The switch is per-agent, and what it costs to make it so is one line of
 * warning.** `/model <alias>` sets this session AND writes the alias to
 * `~/.claude/settings.json` as the default for new sessions everywhere — read
 * out of the CLI: `Set model to X and saved as your default for new sessions`.
 * Session-only exists behind the interactive picker's own key, which a typed
 * command cannot press. So the server records what that file said and puts it
 * back once the write lands (`hold`), which leaves a window — a few seconds at
 * an idle agent, the rest of the turn at a busy one — where the file does hold
 * this alias and an agent started by hand would inherit it.
 *
 * The label is **what the pane is running now**, from the alias and the transcript
 * together — see `modelReading`. It is not a record of the switch: an alias the
 * pane's own later requests contradict is dropped server-side, which is what a
 * refused alias and a `/model` typed in the pane both look like from here. The one
 * case neither signal covers is Claude Code's `Switch model?` confirm on a
 * cross-family switch at an agent that has already worked — the agent shows it and
 * the human answers it in the pane or the blocked panel, and until they do the
 * label reads as the switch they asked for.
 */
function ModelPicker(
  { agent, onPick, onEffort }: {
    agent: AgentRow;
    onPick: (alias: ModelAlias) => void;
    onEffort: (level: EffortLevel) => void;
  },
): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  // An agent that has neither been asked for a model nor answered a request has
  // nothing to report, and a pruned transcript never will — but either can still
  // be asked to switch, so the control stays and only its label goes unknown.
  const name = modelReading(agent.model, agent.alias);
  // One state like the name beside it, and resolved the same way — the server
  // hands over the level asked for while that ask stands, and what the last
  // request ran at once it does not. Absent is a state of its own and reads as
  // one: a model with no effort level shows the name alone rather than a
  // placeholder standing in for a fact.
  const label = agent.effort ? `${name} ·${agent.effort}` : name;

  // A closed agent still ran on something; it just cannot be asked to change.
  if (!agent.live) {
    return agent.model
      ? <span className="shrink-0 text-neutral-600">{label}</span>
      : null;
  }

  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className={open ? 'text-neutral-200' : 'text-neutral-600 hover:text-neutral-300'}
        title="What this agent is running, and at what effort. Both are what the pane was asked for until one of its own requests says otherwise — a refused model, or a level the model capped, is dropped rather than left standing. A transcript cannot say whether the window is 200k or 1M, so that comes from the alias this pane was given; a model with no effort level records none."
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-6 z-10 w-72 rounded border border-neutral-800 bg-neutral-900 p-2">
          {/* Ticked on the alias this pane was ASKED for, which is also what the
              header's label reads while nothing has contradicted it.

              Offered unfiltered because entitlement is the account's and this
              cannot enumerate it — the same reason the settings default passes
              whatever it is given straight through. Only `fable` is marked,
              because it is the one whose cost a human would want to know before
              the click rather than after it. */}
          {MODELS.map((m) => (
            <button
              key={m}
              onClick={() => { setOpen(false); onPick(m); }}
              className={`flex w-full items-center gap-1 rounded px-1 py-0.5 text-left ${
                agent.alias === m
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800'
              }`}
            >
              <span className="truncate">{modelLabel(m)}</span>
              {m === 'fable' && (
                <span
                  className="shrink-0 text-amber-500"
                  title="The most capable model and the dearest — twice opus a token, so it draws the limit bars down fastest. Access is the account's: one without it refuses the switch in the pane."
                >
                  ⚠
                </span>
              )}
            </button>
          ))}
          {/* One popover rather than a second control in the header strip: the
              level is a property of how the model runs, not a fact beside it. */}
          <div className="mt-1.5 flex items-center gap-1 border-t border-neutral-800 pt-1.5">
            <span className="px-1 text-neutral-600">effort</span>
            {EFFORTS.map((e) => (
              <button
                key={e}
                onClick={() => { setOpen(false); onEffort(e); }}
                className={`rounded px-1 py-0.5 ${
                  agent.effort === e
                    ? 'bg-neutral-700 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800'
                }`}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
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
  { agent, tick, copyOnSelect, offline }: {
    agent: AgentRow;
    tick: number;
    copyOnSelect: boolean;
    /** The cockpit's socket or Herdr is down, so every action would fail. */
    offline: boolean;
  },
): React.ReactElement {
  const { post } = useApi();
  const root = useRef<HTMLDivElement>(null);
  const copied = useSelectionCopy(root, copyOnSelect);
  const [tab, setTab] = useState<'feed' | 'diff' | 'subagents' | 'summary'>('feed');
  const [prompt, setPromptState] = useState(() => drafts.get(agent.paneId) ?? '');
  const setPrompt = (text: string): void => {
    setPromptState(text);
    if (text) drafts.set(agent.paneId, text);
    else drafts.delete(agent.paneId);
  };
  const [error, setError] = useState<string | null>(null);
  /** What the action in flight is doing, in words — the spinner's label. */
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Why the prompt box will not take text right now, or null when it will.
   * Read-only rather than disabled, so the caret stays put and typing carries
   * on the moment it clears.
   */
  const lock = offline ? 'reconnecting…' : agent.launching ? 'agent starting…' : busy;
  /**
   * Why a send would be refused while typing is still fine. Measured: Herdr
   * answers a prompt at a blocked agent `agent_blocked` and leaves the dialog
   * untouched, so the draft can simply wait for the answer.
   */
  const held = agent.status === 'blocked' ? 'answer the prompt above first' : null;
  /** /clear destroys a conversation, so it does not fire on one click. */
  const [confirmClear, setConfirmClear] = useState(false);
  /**
   * The fork and the files split this view rather than replacing a tab, because
   * the whole point of both is reading the output and the answer — or the file —
   * at the same time. Remembered per pane across a `/clear` too: the server
   * closes the fork when the session ends, so a fork panel coming back open is
   * an empty one whose next question forks the new conversation.
   */
  const [panels, setPanels] = useState<Panels>(() => panelsOf(agent.paneId, agent.cwd));
  useEffect(() => rememberPanels(agent.paneId, agent.cwd, panels), [agent.paneId, agent.cwd, panels]);
  const [splitW, setSplitW] = useState(() => ({ ...widths }));
  // Live only: a fork is of a running session, and the button that shuts the
  // panel is drawn for a live agent alone — so a RECENT or dormant row keeps the
  // remembered choice without showing a panel nothing could close.
  const forkOpen = (panels.fork || panels.runs) && agent.live;
  /**
   * ▶ runs the feed has handed off and the run panel has not yet taken. The
   * panel does the send, because it is what knows the baseline a run is told
   * apart from an earlier one of the same command by — and a queue rather than
   * a slot, so two quick ▶s on two blocks cannot lose one while its block
   * already says it ran.
   */
  const [runQueue, setRunQueue] = useState<RunRequest[]>([]);
  const runInFork = useCallback((code: string, language: string | null) => {
    setPanels((s) => ({ ...s, runs: true }));
    setRunQueue((q) => [...q, { code, language }]);
  }, []);
  const takeRun = useCallback(() => setRunQueue((q) => q.slice(1)), []);
  /** The feed's blocks and the run fork's own proposals run into the one queue. */
  const forkRunner = useMemo<ShellRunner>(() => ({ target: 'the run fork', run: runInFork }), [runInFork]);
  /**
   * What each column is drawn at, 0 when shut. The drag holds the shared
   * ceiling, but opening the second column does not drag anything, so the files
   * yield here to whatever room the fork has left them.
   */
  const shownW: Record<Column, number> = {
    fork: forkOpen ? splitW.fork : 0,
    files: panels.files.length
      ? Math.max(
        SPLIT_MIN_W,
        Math.min(splitW.files, (window.innerWidth * SPLIT_MAX_VW) / 100 - (forkOpen ? splitW.fork : 0)),
      )
      : 0,
  };
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

  /** Resolves whether the action went, so a caller can keep what it would send. */
  const call = async (label: string, path: string, body?: unknown): Promise<boolean> => {
    setBusy(label);
    setError(null);
    try {
      await post(path, body);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  // Cleared only once it went, so a refused send keeps the text. The stored
  // draft goes at once, though: a `/clear` remounts this view before the send
  // resolves, and the new mount would otherwise come up holding it, unlocked.
  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || lock || held) return;
    drafts.delete(agent.paneId);
    if (await call('sending…', `/api/agents/${agent.paneId}/prompt`, { text })) setPrompt('');
    else drafts.set(agent.paneId, prompt);
  };

  /**
   * Drags a column wider by its left border: left is where it grows. Listens on
   * the window rather than the strip so the drag survives the pointer outrunning
   * an 8px target, and `pointercancel` ends it too — nothing follows one, so a
   * drag left bound there would keep resizing with no button held.
   *
   * The ceiling is shared, so the other open column's width comes off it: two
   * columns each allowed the whole of it would push the feed off the screen.
   */
  const startSplitResize = (col: Column) => (e: React.PointerEvent): void => {
    e.preventDefault();
    const originX = e.clientX;
    const originW = shownW[col];
    const ceiling = (window.innerWidth * SPLIT_MAX_VW) / 100 - (col === 'fork' ? shownW.files : shownW.fork);
    const move = (ev: PointerEvent): void => {
      widths[col] = Math.max(SPLIT_MIN_W, Math.min(ceiling, originW + originX - ev.clientX));
      setSplitW({ ...widths });
    };
    const stop = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const resizer = (col: Column): React.ReactElement => (
    <div
      onPointerDown={startSplitResize(col)}
      title="Drag to resize"
      className="w-1 shrink-0 cursor-ew-resize bg-neutral-800 hover:bg-neutral-600"
    />
  );

  /**
   * Slash commands go down the same path as any other prompt — Claude Code
   * interprets the leading "/" itself, so nothing here needs to know what they
   * mean. Verified for /clear, /goal and /exit.
   */
  const command = async (text: string): Promise<boolean> =>
    !lock && call(`${text.split(' ')[0]}…`, `/api/agents/${agent.paneId}/prompt`, { text });

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

  /**
   * What a file reference does when clicked, wherever it appears — a tool row, a
   * code span in the agent's prose, a code span in a file the panel is already
   * showing. A file already open moves to the top rather than opening twice, and
   * past `MAX_FILES` the oldest closes: each file is a share of one column's
   * height, and a dozen shares is a dozen headers with nothing under them.
   * Memoised on the cwd alone, since the setter is stable.
   */
  const viewer = useMemo<FileViewer>(
    () => ({
      cwd: agent.cwd,
      open: (p) => setPanels((s) => ({
        ...s,
        files: [p, ...s.files.filter((f) => f !== p)].slice(0, MAX_FILES),
      })),
    }),
    [agent.cwd],
  );

  /** Sends whichever command opened the box, and shuts it. */
  const compose = async (): Promise<void> => {
    const text = composeText.trim();
    if (!composing || !text || lock) return;
    if (await command(`/${composing} ${text}`)) {
      setComposeText('');
      setComposing(null);
    }
  };

  return (
    <div ref={root} className="flex h-full flex-col text-xs">
      {copied}
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <StatusDot agent={agent} />
        <span className={`truncate ${nameTone(agent.assignment)}`}>{agent.name}</span>
        <span className="text-neutral-600">{agent.repo}</span>
        <span className="text-neutral-500">{agent.status}</span>
        <span className="text-neutral-600">{since(agent.stateSince)}</span>
        {/* Room here for both numbers; the board row only has room for the share. */}
        <ContextMeter context={agent.context} tokens />
        <ModelPicker
          agent={agent}
          onPick={(alias) => void call('switching model…', `/api/agents/${agent.paneId}/model`, { alias })}
          onEffort={(level) => void call('setting effort…', `/api/agents/${agent.paneId}/effort`, { level })}
        />
        {/* A live agent's prompt bar says this already, where the box it locks is. */}
        {busy && !agent.live && <Spinner label={busy} />}

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
                onClick={() => setPanels((s) => ({ ...s, fork: !s.fork }))}
                className={panels.fork ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                title="Ask about this without spending the agent's turn — forks the session, so its feed does not move"
              >
                fork
              </button>
              <button
                onClick={() => {
                  // Shutting drops what is queued, as the panel's own × does.
                  if (panels.runs) setRunQueue([]);
                  setPanels((s) => ({ ...s, runs: !s.runs }));
                }}
                className={panels.runs ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                title="The ▶ runs from this agent's blocks — a fork of its session runs each and explains the result"
              >
                runs
              </button>
              <button
                onClick={() => open('goal')}
                className={composing === 'goal' ? 'text-neutral-200' : 'text-neutral-400 hover:text-neutral-200'}
                title="Set a completion condition the agent works toward on its own"
              >
                goal
              </button>
              <button
                onClick={() => void call('interrupting…', `/api/agents/${agent.paneId}/interrupt`)}
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
      {agent.dormant && (
        <div className="flex items-baseline gap-2 border-b border-neutral-800 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-neutral-400">
            not running — Herdr could not resume this conversation when it restored the pane
          </span>
          <button
            disabled={busy !== null}
            onClick={() => void call('resuming…', `/api/agents/${agent.paneId}/resume`)}
            className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            title="Starts claude --resume in the same pane, with the rules and model a cockpit start passes. Takes a few seconds."
          >
            resume
          </button>
        </div>
      )}
      {agent.stalled && (
        <div className="flex items-baseline gap-2 border-b border-neutral-800 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-neutral-400">
            not up after 30s — Herdr registered this agent and nothing reported in; it holds the name until closed. Check the pane in Herdr before closing
          </span>
          <button
            disabled={busy !== null}
            onClick={() => void call('closing…', `/api/tabs/${agent.tabId}/close`)}
            className="shrink-0 rounded bg-neutral-800 px-2 py-0.5 text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            title="Closes the tab. The pane may still say what went wrong — look in Herdr first if you want to know."
          >
            close
          </button>
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
            readOnly={lock !== null}
          />
          <button
            disabled={!composeText.trim() || lock !== null}
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
              disabled={lock !== null}
              onClick={() => { void command('/goal clear'); setComposing(null); }}
              className="px-2 py-1 text-neutral-400 hover:text-neutral-200 disabled:opacity-40"
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
          {/* Disabled rather than refused inside `command`: the strip shuts on
              the click, so a refusal there would read as a /clear that went. */}
          <button
            disabled={lock !== null}
            onClick={() => { void command('/clear'); setConfirmClear(false); }}
            className="ml-auto rounded border border-amber-700/60 px-2 py-0.5 text-amber-200 hover:bg-amber-900/40 disabled:opacity-40"
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
        {(['feed', 'diff', 'subagents', 'summary'] as const).map((t) => (
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
        The fork and the files split this row, not the whole view: the prompt bar below
        stays full width and stays the PARENT's, which is the one confusion a
        second input in the same view could cause. Because it is beside the tab
        rather than inside one, a question about the diff is asked the same way
        as a question about the feed.

        Toggling the fork shut only UNMOUNTS its panel — `drop` is the one thing
        that ends the forked agent, so the fork keeps running and is found again
        by name on the next fetch, with its whole exchange. What that costs is the
        draft in its box, which is the right trade against keeping a hidden
        panel's tick-driven fetch alive. The run panel likewise loses a pending
        run's live tail, never the run: it lands as an entry when reopened.
      */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Each tab owns its own height: the diff scrolls its tree and its hunks
            apart, and the feed needs its scrollport to be its own element. */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {tab === 'feed' && (
            <Feed
              paneId={agent.paneId}
              tick={tick}
              jump={jump}
              viewer={viewer}
              runner={agent.live ? forkRunner : undefined}
            />
          )}
          {tab === 'diff' && <DiffTab paneId={agent.paneId} tick={tick} viewer={viewer} />}
          {tab === 'subagents' && (
            <SubagentsTab paneId={agent.paneId} tick={tick} viewer={viewer} />
          )}
          {tab === 'summary' && <SummaryTab paneId={agent.paneId} tick={tick} viewer={viewer} />}
        </div>
        {forkOpen && (
          <>
            {resizer('fork')}
            {/* The aside over the runs, each an equal share of the height like
                the files beside them, either one alone the whole column. */}
            <div style={{ width: shownW.fork }} className="flex min-w-0 shrink-0 flex-col overflow-hidden">
              {panels.fork && (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ForkPanel
                    kind="aside"
                    paneId={agent.paneId}
                    tick={tick}
                    viewer={viewer}
                    onClose={() => setPanels((s) => ({ ...s, fork: false }))}
                  />
                </div>
              )}
              {panels.runs && (
                <div className={`min-h-0 flex-1 overflow-hidden ${panels.fork ? 'border-t border-neutral-800' : ''}`}>
                  <ForkPanel
                    kind="run"
                    paneId={agent.paneId}
                    tick={tick}
                    viewer={viewer}
                    runs={{ queue: runQueue, take: takeRun, runner: forkRunner }}
                    // Runs still queued would otherwise fire whenever it next
                    // opens, against whatever fork is there by then.
                    onClose={() => { setRunQueue([]); setPanels((s) => ({ ...s, runs: false })); }}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {panels.files.length > 0 && (
          <>
            {resizer('files')}
            {/* Newest on top, each an equal share of the height and its own
                scrollport, so a long file never pushes the rest out of reach. */}
            <div style={{ width: shownW.files }} className="flex min-w-0 shrink-0 flex-col overflow-hidden">
              {panels.files.map((f, i) => (
                // Keyed on the path, as the diff's copy button is: a file is
                // its own panel, never another's content under its heading.
                <div key={f} className={`min-h-0 flex-1 overflow-hidden ${i ? 'border-t border-neutral-800' : ''}`}>
                  <FileView
                    paneId={agent.paneId}
                    path={f}
                    viewer={viewer}
                    onClose={() => setPanels((s) => ({ ...s, files: s.files.filter((g) => g !== f) }))}
                  />
                </div>
              ))}
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
        <div className="flex items-end gap-2 border-t border-neutral-800 p-2">
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
            `field-sizing: content` sizes the field to its text, typed or pasted
            alike: one line when it holds one, growing as it wraps, up to
            `MAX_VH` and scrolling past it. The browser's measurement, and exact,
            where measuring a scroll height ourselves would be a copy of it that
            runs a frame late.

            Enter still sends, so a newline needs shift. Verified on a live agent
            that this is worth offering: `agent.prompt` types a multi-line text
            into Claude Code's box and submits it as ONE prompt — it does not
            split at the first newline.
          */}
          <textarea
            rows={1}
            style={{ minHeight: PROMPT_ROW_H, maxHeight: `${MAX_VH}vh` }}
            readOnly={lock !== null}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
            }}
            placeholder={agent.launching ? STARTING_HINT : 'prompt this agent…  ⏎ sends, ⇧⏎ newline'}
            className={`field-sizing-content min-w-0 flex-1 resize-none rounded border border-neutral-800 bg-neutral-900 px-2 py-1 ${
              lock ? 'text-neutral-500' : 'text-neutral-200'
            }`}
          />
          {lock ? (
            <span className="shrink-0 py-1"><Spinner label={lock} /></span>
          ) : held ? (
            <span className="shrink-0 py-1 text-neutral-500">{held}</span>
          ) : (
            <button
              disabled={!prompt.trim()}
              onClick={() => void send()}
              className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
            >
              send
            </button>
          )}
        </div>
      )}

    </div>
  );
}

/** A ▶ run handed from a block to the run panel, which sends it. */
interface RunRequest {
  code: string;
  language: string | null;
}

/**
 * The two forks' differences, in one table for `ASSIGN`'s reason: one panel
 * drawn twice must not drift into two opinions about what a fork looks like.
 */
const FORKS = {
  aside: {
    path: 'aside',
    title: 'fork',
    placeholder: 'ask about this…',
    verb: 'ask',
    empty: 'Ask about anything on the left. The question runs in a fork of this agent’s session, so its feed does not move.',
  },
  run: {
    path: 'run',
    title: 'runs',
    placeholder: 'reply to the run fork…',
    verb: 'send',
    empty: '▶ run a shell block on the left. It runs in a fork of this agent’s session, which explains the result and proposes what to run next — the agent never sees it.',
  },
} as const;

/** Recorded runs of exactly this command that have printed — what landing is counted in. */
const runsOf = (entries: FeedEntry[], command: string): number =>
  entries.filter((e) => e.kind === 'shell' && e.command === command && e.output !== null).length;

/**
 * A side conversation forked off this agent's session, so a question about what
 * it just said — or a command run against its work — costs it nothing: the fork
 * gets its own transcript and the agent's feed does not move.
 *
 * Only the exchange since the fork is shown. The conversation it was forked
 * with is the feed to the left of this panel, and rendering it twice on one
 * screen would be the whole point of the split thrown away.
 *
 * There is no start button. The panel opens empty and the first question — or
 * the first ▶ run — forks the session, which is slow the first time and says so.
 *
 * `runs` is the run fork's alone: the queue the feed's ▶ fills, and the runner
 * that makes the fork's own proposed commands runnable into the same queue.
 */
function ForkPanel(
  { kind, paneId, tick, viewer, runs, onClose }: {
    kind: keyof typeof FORKS;
    paneId: string;
    tick: number;
    viewer: FileViewer;
    runs?: { queue: RunRequest[]; take: () => void; runner: ShellRunner };
    onClose: () => void;
  },
): React.ReactElement {
  const fork = FORKS[kind];
  const { get, post } = useApi();
  const [view, setView] = useState<AsideView | null>(null);
  /**
   * Whether the first fetch is back. A run is told apart from an earlier one of
   * the same command by counting them, and counting before the view arrives
   * would take a run that finished an hour ago for the one just sent.
   */
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  /** Bumped to refetch straight after acting, rather than waiting for a tick. */
  const [reload, setReload] = useState(0);
  /**
   * The run in flight: how many of its command had printed before it, and the
   * tail as it read BEFORE the send. A run queued behind the fork's reply is not
   * echoed yet, so the tail finds an older echo of the same command and would
   * present its output as this run's — the baseline is what is ignored.
   */
  const [pending, setPending] = useState<
    { command: string; head: string; baseline: number; before: string | null; queued: boolean } | null
  >(null);
  const [live, setLive] = useState<string[] | null>(null);

  // A successful poll is not evidence that your last action worked, so it does
  // not clear the banner — an action's own start does. Otherwise the refetch
  // these actions trigger would wipe their error before it could be read.
  useEffect(() => {
    let alive = true;
    void get<AsideView>(`/api/agents/${paneId}/${fork.path}`)
      .then((v) => { if (alive) setView(v); })
      .catch((e: Error) => { if (alive) setFailed(e.message); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [get, paneId, fork.path, tick, reload]);

  const forkPane = view?.paneId ?? null;
  const tail = useCallback(
    (pane: string, head: string) =>
      get<ShellTail>(`/api/agents/${pane}/shell?head=${encodeURIComponent(head)}`).then((t) => t.lines),
    [get],
  );

  const landed = pending !== null && view !== null && runsOf(view.entries, pending.command) > pending.baseline;
  useEffect(() => {
    if (landed) { setPending(null); setLive(null); }
  }, [landed]);

  // While a run is pending the fork's pane is the only place its output exists,
  // so it is tailed on every tick. Not before the fork has a pane: the first
  // run is still starting it.
  useEffect(() => {
    if (!pending || pending.before === null || !forkPane) return;
    let alive = true;
    void tail(forkPane, pending.head)
      .then((l) => { if (alive) setLive(JSON.stringify(l) === pending.before ? null : l); })
      .catch(() => {});
    return () => { alive = false; };
  }, [pending, forkPane, tail, tick]);

  const start = async ({ code, language }: RunRequest): Promise<void> => {
    const command = bashMode(code, language);
    if (!command) return;
    setBusy(true);
    setFailed(null);
    const head = command.split('\n')[0];
    // No baseline for the run that starts the fork, so it is not tailed: the
    // resumed conversation may redraw an older echo of this same command.
    const before = forkPane ? JSON.stringify(await tail(forkPane, head).catch(() => null)) : null;
    setPending({
      command,
      head,
      baseline: runsOf(view?.entries ?? [], command),
      before,
      queued: view?.status === 'working',
    });
    try {
      await post(`/api/agents/${paneId}/shell`, { code, language });
    } catch (e) {
      setFailed((e as Error).message);
      setPending(null);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };

  // One run at a time, taken once the view is in to count against. Waiting out
  // `busy` is also what keeps two runs during the first one's ~10s start from
  // forking twice under one name.
  const next = runs?.queue[0];
  const take = runs?.take;
  useEffect(() => {
    if (!next || !take || !loaded || busy || pending) return;
    take();
    void start(next);
    // Not on `start`, which is rebuilt every render: the guards are what gate it.
  }, [next, take, loaded, busy, pending]);

  const ask = async (): Promise<void> => {
    const question = text.trim();
    // The button is disabled while busy and the Enter key is not, and the first
    // question takes ~10s — long enough to type a second and fork twice.
    if (!question || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/${fork.path}`, { text: question });
      setText('');
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
    // A post in flight may be starting this very fork; its `finally` would
    // clear `busy` mid-close and let the next queued run start another.
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await post(`/api/agents/${paneId}/${fork.path}/close`);
      setView(null);
      // Its baseline counted the old fork's runs, so it could never land in the
      // next one — and the queue waits on it.
      setPending(null);
      setLive(null);
      if (!keepOpen) onClose();
    } catch (e) {
      setFailed((e as Error).message);
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };

  const open = view?.paneId != null;

  // The fork's entries are only ever appended to, so an index is a stable key.
  const entries = view?.entries ?? [];
  const asked = entries.findLastIndex((e) => e.kind === 'user');
  const [jump, setJump] = useState(0);
  const { view: scroller, prompt, end, setBody, room, flash } = usePromptJump(
    asked < 0 ? null : String(asked),
    jump,
  );

  return (
    <div className="flex h-full min-h-0 flex-col border-l border-neutral-800 text-xs">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-800 px-2 py-1.5">
        {view?.status && <StatusDot agent={{ status: view.status, error: null }} />}
        <span className="text-neutral-400">{fork.title}</span>
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
          {/* Not while the first prompt is forking: shutting the panel would not
              stop the start, and the fork would come up with nobody watching. */}
          <button
            disabled={busy && !open}
            onClick={() => void (open ? drop(false) : onClose())}
            className="text-neutral-500 hover:text-neutral-200 disabled:opacity-40"
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

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        <div ref={setBody}>
          {entries.map((entry, i) =>
            i === asked
              ? (
                <Spotlit key={i} ref={prompt} flash={flash}>
                  <EntryRow entry={entry} viewer={viewer} runner={runs?.runner} />
                </Spotlit>
              )
              : <EntryRow key={i} entry={entry} viewer={viewer} runner={runs?.runner} />
          )}
          {pending
            ? (
              <div className="my-2 rounded border border-neutral-800 bg-neutral-900/50 px-2 py-1.5">
                <div className="truncate font-mono text-neutral-400">! {pending.head}</div>
                {live && live.length > 0 && <Stream text={live.join('\n')} />}
                <div className="flex items-center gap-2 text-[11px]">
                  <Spinner
                    label={!open
                      ? 'forking the session — a tab, a launch and a copy of the context, about 10s'
                      : live ? 'running…' : pending.queued ? 'queued behind the fork’s reply…' : 'sent…'}
                  />
                  <button
                    onClick={() => { setPending(null); setLive(null); }}
                    title="Stop watching. The run itself is not stopped, and its output arrives here when it lands."
                    className="ml-auto text-neutral-600 hover:text-neutral-300"
                  >
                    ×
                  </button>
                </div>
              </div>
            )
            : !entries.length && (
              <p className="py-2 text-neutral-600">
                {busy && !open ? 'forking the session — a tab, a launch and a copy of the context, about 10s' : fork.empty}
              </p>
            )}
        </div>
        <div ref={end} style={{ height: room }} />
      </div>

      <div className="flex shrink-0 gap-2 border-t border-neutral-800 p-2">
        <button
          onClick={() => setJump((n) => n + 1)}
          title="Jump to your last prompt"
          className="px-1 py-1 text-neutral-500 hover:text-neutral-200"
        >
          ⤒
        </button>
        <input
          readOnly={busy}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void ask(); }}
          placeholder={fork.placeholder}
          className={`min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 ${
            busy ? 'text-neutral-500' : 'text-neutral-200'
          }`}
        />
        <button
          disabled={busy || !text.trim()}
          onClick={() => void ask()}
          className="rounded bg-neutral-800 px-2 py-1 text-neutral-200 disabled:opacity-40"
        >
          {fork.verb}
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
    } catch (e) {
      // A refused Enter (`answerKeys`) changes nothing on screen, so the re-read
      // alone would look like a key that simply did not take.
      setFailed((e as Error).message);
    }
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
