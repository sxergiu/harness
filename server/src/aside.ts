import type { AgentRow, AsideView } from '@harness/shared';
import { touchedPaths } from './diff.js';
import { asStatus, type AgentInfo, type Herdr } from './herdr.js';
import { asideArgs } from './rules.js';
import { Transcripts, feedTurns, transcriptPathFor, type Entry } from './transcript.js';

/**
 * An ASIDE: a side conversation forked off an agent's session, so the human can
 * ask what a piece of output meant without spending that agent's turn on it.
 *
 * `--fork-session` is the whole mechanism. Verified against live pane w2:pG: the
 * fork resumed a session that was running, and the parent's transcript was
 * byte-identical afterwards. The fork gets a transcript of its own holding the
 * parent's entire conversation rewritten under a new session id, plus the new
 * exchange.
 *
 * That copy is also the hazard. Its `toolUseResult` entries are the PARENT's
 * writes, so an aside on the board would claim the parent's whole changelist and
 * contend with it over every file — the thing invariant 10 exists to prevent. So
 * asides are excluded from the board (`board.ts`), never diffed, and everything
 * here is derived from the entries the parent has never seen.
 *
 * Nothing is remembered between calls. The aside is found again by NAME, which
 * is derived from the parent's pane, so a harness restart neither strands one
 * nor starts a second — the same trick `usage.ts` uses.
 */

/** Marks our panes on the board's exclusion list. A human's agent must not use it. */
export const ASIDE_PREFIX = 'aside-';

const EMPTY: AsideView = { paneId: null, status: null, entries: [], filesWritten: 0 };

/**
 * `w2:pJ` → `aside-w2-pj`. Herdr's rule is `[a-z][a-z0-9_-]{0,31}`, and pane ids
 * are `w<n>:p<base36 uppercase>` — no lowercase letter ever occurs in one, so
 * lowercasing cannot map two panes onto one name. The longest real id leaves the
 * result well inside 32 characters.
 */
export const asideName = (parentPaneId: string): string =>
  ASIDE_PREFIX + parentPaneId.toLowerCase().replace(/[^a-z0-9]+/g, '-');

export class Aside {
  /** Fork transcripts are read here and nowhere else; the board never sees one. */
  private readonly transcripts = new Transcripts();

  constructor(private readonly herdr: Herdr) {}

  async view(parent: AgentRow, parentEntries: Entry[]): Promise<AsideView> {
    const open = await this.current(parent.paneId, parentEntries);
    if (!open) return EMPTY;

    const { info, fresh } = open;
    return {
      paneId: info.pane_id,
      status: info.agent_status === undefined ? null : asStatus(info.agent_status),
      entries: feedTurns(fresh, info.cwd ?? parent.cwd).flatMap((t) => t.entries),
      // Over `fresh` and never over the whole fork, which would report the
      // parent's files as the aside's.
      filesWritten: touchedPaths(fresh).length,
    };
  }

  /**
   * Asks the aside, starting one first if there is none. The first question
   * therefore costs a tab create and a launch (invariants 12 and 13) plus
   * however long Claude Code takes to load a forked transcript; later ones are
   * an ordinary prompt.
   *
   * Reforking is this same path: `close` leaves no aside, so the next question
   * forks again from wherever the parent has got to.
   */
  async send(parent: AgentRow, parentEntries: Entry[], text: string): Promise<void> {
    const open = await this.current(parent.paneId, parentEntries);
    const paneId = open ? open.info.pane_id : await this.start(parent);
    await this.herdr.prompt(paneId, text);
  }

  /**
   * `tab.close` rather than `/exit`: it ends the agent AND removes the pane,
   * where `/exit` would cost a turn and leave a bare shell behind.
   */
  async close(parentPaneId: string): Promise<void> {
    const info = await this.herdr.agentInfo(asideName(parentPaneId));
    if (!info) return;
    // Not the same as having no aside, and it must not read as one: answering
    // ok would shut the panel over a fork that is still running, and the next
    // question would start a second one under the same name.
    if (!info.tab_id) throw new Error('herdr gave the aside no tab to close');
    await this.herdr.request('tab.close', { tab_id: info.tab_id });
  }

  /**
   * The aside for this parent and the exchange that is its own, or null when
   * there is none — including when the one there forks a conversation the
   * parent has since discarded, which is closed here rather than answered from.
   */
  private async current(
    parentPaneId: string,
    parentEntries: Entry[],
  ): Promise<{ info: AgentInfo; fresh: Entry[] } | null> {
    const info = await this.herdr.agentInfo(asideName(parentPaneId));
    if (!info) return null;

    const path = info.cwd && info.agent_session
      ? transcriptPathFor(info.cwd, info.agent_session.value)
      : null;
    // A fork that has not written its transcript yet is an ordinary state, and
    // so is one that has been pruned (invariant 9): both read as no exchange.
    const fresh = freshEntries(path ? this.transcripts.entries(path) : [], parentEntries);
    if (fresh === null) {
      await this.close(parentPaneId);
      return null;
    }
    return { info, fresh };
  }

  private async start(parent: AgentRow): Promise<string> {
    if (!parent.sessionUuid) throw new Error('this agent has no session to fork');

    // The parent's space and directory, not a space of our own: `--resume` finds
    // a session by the project directory it was recorded under. A fork of a
    // session that has since gone is the failure `launchAgent` cleans up after —
    // `claude` prints "No conversation found" and exits, and the tab would
    // otherwise stay as a bare shell nothing can find again.
    return this.herdr.launchAgent(
      asideName(parent.paneId),
      { workspaceId: parent.workspaceId, cwd: parent.cwd, label: 'aside' },
      asideArgs(parent.sessionUuid),
    );
  }
}

/**
 * The exchange the aside added, as against the conversation it was forked with.
 * Null means the fork is of a session that is gone — the parent has `/clear`ed,
 * and the aside is answering out of a conversation that no longer exists.
 *
 * Entries with no uuid are skipped on both sides. The fork writes fresh copies
 * of the bookkeeping types, so counting those would make every new fork look
 * like it had already said something.
 */
function freshEntries(fork: Entry[], parent: Entry[]): Entry[] | null {
  const inherited = new Set<string>();
  for (const e of parent) if (e.uuid) inherited.add(e.uuid);

  // With nothing to compare against, every entry in the fork looks new — and
  // "new" would render the parent's whole conversation into the panel beside
  // itself. A pruned parent transcript is exactly this case, so it answers
  // with nothing rather than with everything.
  if (inherited.size === 0) return [];

  const fresh: Entry[] = [];
  let shared = 0;
  for (const e of fork) {
    if (!e.uuid) continue;
    if (inherited.has(e.uuid)) shared++;
    else fresh.push(e);
  }
  // Not one entry in common: these are two unrelated conversations.
  return shared === 0 && fresh.length > 0 ? null : fresh;
}
