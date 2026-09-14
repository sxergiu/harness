import type { AgentRow, SubagentStatus } from '@harness/shared';

/**
 * The two things every surface has to say: what state an agent is in, and
 * whether something is happening right now. Both live here so the board row,
 * the agent header and the panels cannot drift apart on what "working" looks
 * like — they were already three separate opinions about one dot.
 */

const DOT: Record<AgentRow['status'], string> = {
  blocked: 'bg-amber-400',
  done: 'bg-emerald-400',
  working: 'bg-sky-400',
  idle: 'bg-neutral-600',
  unknown: 'bg-neutral-700',
};

/**
 * An unresolved error outranks the status: Herdr still calls a stalled agent
 * `idle`, which is true and useless. Working pulses — that pulse is the whole
 * reason a row reads as alive rather than merely blue.
 *
 * Takes the two fields rather than a row, because an aside has a status and no
 * board row of its own — and it must not read as a different kind of thing.
 */
export function StatusDot(
  { agent }: { agent: Pick<AgentRow, 'status' | 'error'> },
): React.ReactElement {
  const failed = Boolean(agent.error);
  return (
    <span
      title={agent.error ?? agent.status}
      className={`h-2 w-2 shrink-0 rounded-full ${failed ? 'bg-red-500' : DOT[agent.status]} ${
        agent.status === 'working' && !failed ? 'animate-pulse' : ''
      }`}
    />
  );
}

/**
 * A subagent's derived state. Deliberately the same shapes as `StatusDot`:
 * running pulses exactly as a working agent does, because it is the same fact.
 * `stopped` is muted rather than red — a subagent the parent never collected is
 * usually just an interrupted turn, not a failure.
 */
const SUBAGENT: Record<SubagentStatus, { dot: string; text: string; title: string }> = {
  running: {
    dot: 'bg-sky-400 animate-pulse',
    text: 'text-sky-300',
    title: 'still running — the parent has not recorded a result yet',
  },
  waiting: {
    dot: 'bg-amber-400',
    text: 'text-amber-300',
    title: 'the parent agent is blocked, most likely on this subagent’s tool',
  },
  finished: {
    dot: 'bg-emerald-400',
    text: 'text-emerald-400',
    title: 'finished — the parent recorded its result',
  },
  stopped: {
    dot: 'bg-neutral-600',
    text: 'text-neutral-500',
    title: 'never returned a result, and the parent is no longer working',
  },
};

export function SubagentDot({ status }: { status: SubagentStatus }): React.ReactElement {
  const s = SUBAGENT[status];
  return <span title={s.title} className={`h-2 w-2 shrink-0 rounded-full ${s.dot}`} />;
}

export const subagentText = (status: SubagentStatus): string => SUBAGENT[status].text;

/**
 * A fork's state, on its parent's board row. It deliberately does NOT use `DOT`
 * above, and the reason is measured rather than aesthetic: Herdr's `done` means
 * idle-after-work-unseen-IN-THE-TERMINAL, and the cockpit focuses a pane
 * whenever you open that agent, so of nine live agents every one read `idle`
 * except the one actually working. `idle` is therefore the resting state of a
 * fork with an answer sitting in it, where `DOT` paints `idle` the same grey
 * this table keeps for a fork that is GONE — the opposite reading.
 *
 * So `done`, `idle` and `unknown` collapse to one colour and grey means cleared.
 * `working` and `blocked` keep the meaning they have for an agent, because the
 * board is where nobody is looking at the fork and they would otherwise pass
 * unseen. Inside the panel you ARE looking, so its own header keeps `StatusDot`
 * and its grey-for-idle is right there.
 */
const FORK: Record<NonNullable<AgentRow['aside']>, { ring: string; title: string }> = {
  working: { ring: 'border-sky-400 animate-pulse', title: 'the fork is working on your question' },
  blocked: {
    ring: 'border-amber-400',
    title: 'the fork is blocked — it is waiting on a prompt in its own pane',
  },
  done: { ring: 'border-emerald-400', title: 'the fork has an answer waiting' },
  idle: { ring: 'border-emerald-400', title: 'the fork has an answer waiting' },
  unknown: {
    ring: 'border-emerald-400',
    title: 'the fork is open; Herdr does not say what it is doing',
  },
  cleared: {
    // Broken rather than merely darker: every state is an outline now, so grey
    // alone is a hue difference against a selected row and very nearly nothing
    // at this size. A ring with gaps in it reads as "was" without competing
    // with the live colours.
    ring: 'border-dashed border-neutral-600',
    title: 'this agent had a fork; it has been dropped',
  },
};

/**
 * Drawn AROUND the agent's own dot rather than beside it: the fork belongs to
 * that agent, and a second dot on the row read as another status of its own.
 *
 * The box is reserved whether or not there is a fork, because it sits at the
 * head of every row and a ring that changed the row's width would step the
 * whole column in and out as forks come and go. It is a hair wider than the dot
 * so the gap is visible — a ring flush against the dot reads as a halo on the
 * status colour, which is the one thing it must not say.
 */
export function ForkRing(
  { fork, children }: { fork: AgentRow['aside']; children: React.ReactNode },
): React.ReactElement {
  const f = fork ? FORK[fork] : null;
  return (
    // The title is the ring's, and the dot's own wins wherever they overlap:
    // hovering the centre is asking about the agent, the edge about the fork.
    <span title={f?.title} className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      {f && (
        // Transparent inside but it still covers the dot: without this the ring
        // takes every hover and the dot's status title can never be read.
        <span
          aria-hidden
          className={`pointer-events-none absolute inset-0 rounded-full border ${f.ring}`}
        />
      )}
      {children}
    </span>
  );
}

/**
 * Work the HARNESS is doing — a fetch in flight, an action awaiting Herdr.
 * Distinct from `StatusDot`, which is about the agent. Conflating the two is
 * how a spinner ends up lying about which side is busy.
 */
export function Spinner({ label }: { label?: string }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 text-neutral-500">
      <span
        aria-hidden
        className="h-3 w-3 animate-spin rounded-full border border-neutral-600 border-t-transparent"
      />
      {label !== undefined && <span>{label}</span>}
    </span>
  );
}

/**
 * How full this session's context is. Colour is the whole point: the number
 * only matters as it approaches the window, where Claude Code compacts and the
 * agent loses the middle of its conversation.
 *
 * Shown as a share because that is the decision ("time to /clear?"); the exact
 * token count and the window it is measured against are on the tooltip, which
 * is also where the window's inferred nature is admitted.
 */
export function ContextMeter(
  { context, tokens = false }: { context: AgentRow['context']; tokens?: boolean },
): React.ReactElement | null {
  if (!context || context.window <= 0) return null;
  const percent = Math.round((context.tokens / context.window) * 100);
  const tone = percent >= 85 ? 'text-red-400' : percent >= 60 ? 'text-amber-400' : 'text-neutral-500';
  return (
    <span
      className={`shrink-0 tabular-nums ${tone}`}
      title={`${context.tokens.toLocaleString()} of about ${short(context.window)} context tokens — the window is inferred, not reported`}
    >
      {tokens && `${short(context.tokens)} `}
      {percent}%
    </span>
  );
}

/** 84_231 → "84k". Token counts are only ever read at a glance. */
function short(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `${Math.round(n / 1000)}k`;
}

/**
 * What the agent is doing, live. Shown wherever there is room for a line rather
 * than a dot; `activity` is the newest tool call and is null before the first.
 */
export function Working({ agent }: { agent: AgentRow }): React.ReactElement {
  return (
    <span className="inline-flex min-w-0 items-center gap-2 text-sky-300/90">
      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400" />
      <span className="truncate">{agent.activity ?? 'working…'}</span>
    </span>
  );
}
