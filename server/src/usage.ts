import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { UsageLimit, UsageView } from '@harness/shared';
import { trustFolder } from './claudeFiles.js';
import type { Herdr } from './herdr.js';

/**
 * The account's limits, read the only way they can be read: `/usage` draws a
 * terminal dialog and writes nothing to the transcript, so something has to run
 * it in a pane, look at the screen and dismiss it.
 *
 * That something is a pane of our own. Borrowing a working agent's pane — which
 * is what this did — costs that agent a turn: the prompt queues behind whatever
 * it is doing, its transcript gains a `/usage` it never asked for, and if it is
 * busy the dialog does not open at all, so the reading fails for a reason that
 * has nothing to do with usage. The limits are an account-wide fact and belong
 * to no agent, so they are read through an agent that has no work to lose.
 *
 * The pane is kept between readings — starting one costs ~4s (invariants 12 and
 * 13), a repeat reading about a second — and is adopted back by name after a
 * harness restart, so restarting does not strand the last one.
 */

/** The name our own agent goes by. Herdr's rule: [a-z][a-z0-9_-]{0,31}. */
export const USAGE_AGENT = 'harness-usage';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Usage {
  private paneId: string | null = null;

  constructor(private readonly herdr: Herdr) {}

  /**
   * One reading, with one retry — the two ways a first attempt fails are both
   * ordinary, and both are answered by asking again.
   *
   * A pane we REMEMBERED may simply be gone; the human can close it whenever
   * they like. That retry starts a new agent.
   *
   * A pane we JUST STARTED opens the dialog but has not yet filled in the
   * limits: measured on a cold agent, the panel was on screen with its heading
   * and nothing under it, and the poll gave up before the numbers arrived. The
   * same request a moment later answered in 1.2s. That retry re-asks the same
   * pane, which by then is warm.
   */
  async read(): Promise<UsageView> {
    for (let attempt = 0; ; attempt++) {
      const remembered = this.paneId !== null;
      try {
        return await this.capture(await this.pane());
      } catch (err) {
        if (attempt > 0) throw err;
        if (remembered) this.paneId = null;
      }
    }
  }

  /**
   * Our pane, in three escalating steps: the one we are already using, the one
   * a previous harness left behind (found by name — Herdr keeps it, we do not
   * persist it), or a new one.
   */
  private async pane(): Promise<string> {
    if (this.paneId !== null) return this.paneId;

    const snap = await this.herdr.snapshot();
    const existing = (snap.agents ?? []).find((a) => a.name === USAGE_AGENT);
    if (existing) {
      this.paneId = existing.pane_id;
      return existing.pane_id;
    }

    const workspace = snap.workspaces[0];
    if (!workspace) throw new Error('herdr has no space to open the usage agent in');

    // Our own directory, not a repo and not the home directory: this agent
    // reads a dialog and edits nothing, and a cwd inside a project would file
    // its transcript among that project's agents. It is also the one folder
    // whose trust dialog the harness can answer on the human's behalf without
    // deciding anything for them — see `trustFolder`, which grants it here so
    // a cold start meets a prompt box rather than a security question.
    // No `startArgs()` either: those rules are for agents that write code, and
    // this one runs one slash command and is never prompted by a human.
    const cwd = join(homedir(), '.harness');
    mkdirSync(cwd, { recursive: true });
    trustFolder(cwd);

    const paneId = await this.herdr.launchAgent(
      USAGE_AGENT,
      { workspaceId: workspace.workspace_id, cwd, label: 'usage' },
      [],
    );

    this.paneId = paneId;
    return paneId;
  }

  /**
   * Ends the reading agent and takes its tab with it — what the harness owes
   * anyone who closes the cockpit, since this pane is an instrument of ours
   * that no human asked for and that nothing else ever talks to.
   *
   * Keeping it BETWEEN readings is the optimisation (~10s cold against ~1.2s
   * warm) and it is untouched; keeping it after the process that reads it has
   * gone was never one. Adoption by name still covers the harness that does not
   * get to run this — a crash, a kill — so restarting neither strands the last
   * one nor starts a second.
   *
   * The lookup is what makes that adoption clean up too: `paneId` is filled in
   * by a reading, so a cockpit that adopted an old agent and was then closed
   * without ever pressing the button has nothing recorded and would otherwise
   * leave it running.
   */
  async close(): Promise<void> {
    const paneId = this.paneId ?? (await this.herdr.agentInfo(USAGE_AGENT))?.pane_id;
    this.paneId = null;
    if (paneId) await this.herdr.closePane(paneId);
  }

  /**
   * Run it, wait for the panel, read it, dismiss it.
   *
   * The escape goes out ONLY once the panel is really on screen. Sending it
   * blind is the failure this whole path is shaped to avoid — in a pane of our
   * own it would merely be pointless, but the check is what proves the text we
   * are about to return is the dialog and not the pane behind it.
   */
  private async capture(paneId: string): Promise<UsageView> {
    await this.herdr.prompt(paneId, '/usage');

    // Matched on the CROP, not the raw pane: a previous reading leaves its own
    // numbers scrolled up above the rule, and matching those would return the
    // stale panel — or fire the escape before the dialog opened.
    let text: string | null = null;
    for (let attempt = 0; attempt < 10 && text === null; attempt++) {
      await delay(400);
      const panel = cropPanel(await this.herdr.read(paneId, 60));
      if (USAGE_PANEL.test(panel)) text = panel;
    }
    if (text === null) {
      // Safe HERE and nowhere else: this pane exists only to be asked, so a
      // blind escape has no turn to interrupt — the thing that made this
      // impossible while the reading borrowed a working agent's pane. Without
      // it a half-drawn dialog is left open and the retry types into it.
      await this.herdr.sendKeys(paneId, ['escape']).catch(() => {});
      throw new Error('the usage dialog did not open');
    }

    await this.herdr.sendKeys(paneId, ['escape']);
    return { limits: limitsOf(text), text };
  }
}

// ---------------------------------------------------------------------------
// Reading the panel off the screen
// ---------------------------------------------------------------------------

/**
 * Enough of the panel to be sure it is on screen and not something else.
 *
 * `% used` alone is NOT enough: a Claude Code status line reads
 * "Opus 5 (1M context) | Context: 8% used", so matching it accepted a pane with
 * no dialog open, on the very first poll. These three phrases are the panel's
 * own, and each survives a different amount of it scrolling off a short pane —
 * the limit headings, the reset lines, and the tables at the very bottom.
 */
const USAGE_PANEL = /Current (session|week)|^\s*Resets |% of usage/im;

/**
 * Claude Code draws the dialog below a full-width rule, with the transcript
 * still visible above it:
 *
 *   ⏺ Bash(ps -o …)            ← the pane's own scrollback, NOT the panel
 *   ────────────────────────────────────────────────
 *     Settings  Status   Config   Usage   Stats
 *     Current session
 *     ███████▌      15% used
 *
 * The rule is the boundary and the last one wins, the dialog being the newest
 * thing on screen. No rule at all is not a failure: a dialog taller than the
 * pane scrolls its own top off — observed on a 49-row pane — and then every
 * visible line is dialog, which is exactly what keeping all of them gives.
 */
const PANEL_RULE = /^\s*[─━]{20,}\s*$/;

/** Trailing keyboard affordances of a dialog the browser has already dismissed. */
const KEY_HINT = /^\s*(esc|enter|tab|[a-z]) to \w/i;

export function cropPanel(pane: string): string {
  const lines = pane.split('\n');
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (PANEL_RULE.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  let end = lines.length;
  while (end > start) {
    const line = lines[end - 1] ?? '';
    if (line.trim() && !KEY_HINT.test(line)) break;
    end--;
  }
  return lines.slice(start, end).join('\n');
}

/**
 * The two limit bars, pulled out of the panel:
 *
 *   Current session
 *   ███████▌                    15% used
 *   Resets 3:20am (Europe/Bucharest)
 *
 * The heading names the limit and the lines under it carry the number and the
 * reset, so a limit is read from its heading down to the next one. `% used`
 * appears nowhere else — the advice section says "87% of your usage", without
 * "used" — so prose cannot be mistaken for a limit.
 *
 * Nothing here may throw. This is a dialog Claude Code redraws as it likes, and
 * a shape we do not recognise has to come back as no limits, which the browser
 * renders as the raw panel.
 */
const LIMIT_HEADING = /^\s*Current (session|week)\b/i;
const PERCENT = /(\d+)\s*%\s*used/i;
const RESETS = /^\s*Resets\s+(.+?)\s*$/i;

export function limitsOf(panel: string): UsageLimit[] {
  const lines = panel.split('\n');
  const limits: UsageLimit[] = [];

  for (let i = 0; i < lines.length; i++) {
    const label = LIMIT_HEADING.exec(lines[i] ?? '')?.[1];
    if (label === undefined) continue;

    let percent: number | null = null;
    let resets: string | null = null;
    for (let j = i + 1; j < lines.length && !LIMIT_HEADING.test(lines[j] ?? ''); j++) {
      const line = lines[j] ?? '';
      percent ??= Number(PERCENT.exec(line)?.[1] ?? NaN);
      if (Number.isNaN(percent)) percent = null;
      resets ??= RESETS.exec(line)?.[1] ?? null;
      if (percent !== null && resets !== null) break;
    }
    if (percent !== null) limits.push({ label: label.toLowerCase(), percent, resets });
  }
  return limits;
}
