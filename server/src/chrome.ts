import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Herdr } from './herdr.js';
import { log, logError } from './log.js';
import { cropPanel } from './usage.js';

/**
 * Answering Claude in Chrome's site-permission dialog without a human.
 *
 * `herdrRules.ts` made this dialog VISIBLE — without its detection rule the
 * agent sitting at one reads `idle` and the cockpit never shows the blocked
 * panel. This is the other half: for a human who has decided that a browsing
 * agent may browse, the panel appearing at all is the cost, and the agent is
 * stopped until they come back to press a key they were always going to press.
 *
 * It is OFF unless the human turns it on, and that is the whole of the safety
 * here. Nothing else in this cockpit types at a dialog on its own; every other
 * keystroke is one somebody pressed in the blocked panel.
 */

/**
 * Existence IS the setting — the contents are never read. The same
 * delete-to-reset shape `setModelDefault` uses, and it keeps "turned off"
 * indistinguishable from "never turned on", so there is no third state to
 * report.
 *
 * Read per use and never cached, because the settings screen promises this
 * applies to the next dialog rather than to the next harness.
 */
const SETTING = join(homedir(), '.harness', 'chrome-autoaccept');

export function autoAcceptEnabled(): boolean {
  try {
    return statSync(SETTING).isFile();
  } catch {
    return false;
  }
}

export function setAutoAccept(on: boolean): void {
  if (!on) {
    rmSync(SETTING, { force: true });
    return;
  }
  mkdirSync(dirname(SETTING), { recursive: true });
  writeFileSync(SETTING, '');
}

/**
 * The dialog's own heading, which Claude Code builds as `Claude in Chrome wants
 * to ${verb} on ${host}` — and as `Claude in Chrome wants to ${verb}` when it
 * could not resolve a host, so the host is not part of the test.
 *
 * A leading border glyph is tolerated but has not been seen: the dialog
 * measured for the Herdr rule had none, and that rule's own anchors (`^\s*❯?`)
 * would not have fired if it had.
 */
const TITLE = /^[\s│┃|]*Claude in Chrome wants to\b/i;

/** An option row as the dialog's select renders it: `❯ 2. Allow all actions…`. */
const OPTION = /^[\s│┃|]*❯?\s*(\d+)\.\s+(\S.*)$/;

/**
 * The key that answers the dialog on this screen with "allow", or null if the
 * screen is not showing one.
 *
 * THE DIGIT IS READ OFF THE SCREEN, and it must never become a constant. The
 * "Allow all actions on <host> for this session" row is conditional in Claude
 * Code — it renders only when that offer is available and the host resolved —
 * so the list is `Allow / Deny` as often as it is `Allow / Allow-all / Deny`,
 * and in the short layout the `2` that means allow-for-the-session in the long
 * one IS DENY. A fixed keystroke would therefore deny a request roughly as
 * often as it allowed one, and deny it silently: the agent carries on with a
 * refusal it was never given, which looks exactly like a decision from the
 * human. Reading the number the dialog itself printed is the only answer that
 * cannot invert.
 *
 * Allow-all is preferred where it is offered because it settles the host for
 * the session, so the same agent stops asking — and the fewer keystrokes this
 * types into a live terminal, the smaller everything below can go wrong.
 *
 * READ OUT OF THE LIVE REGION ONLY, which is what `cropPanel` already cuts for
 * the usage panel and what the Herdr rule for this very dialog already matches
 * in (`after_last_horizontal_rule`). The pane read carries the scrollback with
 * it, and a dialog's own text sitting up there — answered minutes ago — must
 * never be mistaken for one waiting: the agent would be blocked at some
 * unrelated prompt by then, and the digit meant for the old screen would answer
 * THAT one, in the human's name. One definition of "below the last rule" for
 * both readers, rather than a second one here to drift against it.
 *
 * Within that region it is matched from the LAST heading down and gated on a
 * `Deny` row beneath it, because the option rows are what distinguish a dialog
 * waiting from a heading that has already been answered.
 */
export function allowKey(pane: string): string | null {
  const lines = cropPanel(pane).split('\n');
  const heading = lines.findLastIndex((line) => TITLE.test(line));
  if (heading === -1) return null;

  let allow: string | null = null;
  let allowDomain: string | null = null;
  let deny = false;
  for (const line of lines.slice(heading + 1)) {
    const option = OPTION.exec(line);
    if (!option) continue;
    const [, digit, label] = option;
    if (/^Allow all actions on\b/i.test(label)) allowDomain ??= digit;
    else if (/^Allow\b/i.test(label)) allow ??= digit;
    else if (/^Deny\b/i.test(label)) deny = true;
  }
  return deny ? allowDomain ?? allow : null;
}

/**
 * paneId → the screen we last answered, and a read in flight for it.
 *
 * The send is optimistic, exactly as the blocked panel's keys are: we press and
 * let the next resync show what happened. What optimism cannot survive here is
 * the loop — nobody is watching, so a key that does not take would be re-sent
 * every heartbeat for as long as the agent stays blocked. Remembering the
 * screen bounds it at one keystroke per screen, and a screen that genuinely
 * asks twice is never byte-identical to the one before it: the scrollback above
 * it has grown by the exchange in between.
 *
 * The in-flight set is the same bound against a read slower than the 3s beat,
 * where two passes would otherwise both see the unanswered screen and both
 * press — and the second press lands in the prompt box of an agent that is
 * already working again.
 */
const answered = new Map<string, string>();
const reading = new Set<string>();

/** Herdr recycles pane ids, so nothing keyed on one may outlive the pane. */
export function forgetPane(paneId: string): void {
  answered.delete(paneId);
  reading.delete(paneId);
}

/**
 * The key for this screen, claiming it in the same breath — or null, meaning
 * there is nothing here to answer that has not been answered already.
 *
 * The claim and the answer are ONE STEP because the ordering is the whole
 * safety: the screen has to be recorded before anything is sent, so a send that
 * throws leaves the dialog to the human instead of being retried every
 * heartbeat. Written as a comment over two statements that was one careless
 * reorder away from a keystroke loop; written as a function, the key cannot be
 * obtained without the screen being spent.
 *
 * A screen holding no dialog claims nothing, so a pane that was showing
 * something else is still answerable the moment a real one appears.
 */
export function claimScreen(paneId: string, pane: string): string | null {
  if (answered.get(paneId) === pane) return null;

  const key = allowKey(pane);
  if (key === null) return null;

  answered.set(paneId, pane);
  return key;
}

/**
 * Called for every blocked agent on every resync. Reads the pane only when the
 * human has turned this on — a cockpit with it off makes no extra request and
 * types nothing, which is what keeps this feature off the path of everyone who
 * did not ask for it.
 *
 * Logged rather than notified. A notification for something handled without
 * anybody's attention is the opposite of what a notification is for, but a
 * cockpit that typed at a terminal and left no record of it would be worse, and
 * the log is where the rest of this harness's actions already answer for
 * themselves.
 */
export async function answerChromeDialog(herdr: Herdr, paneId: string, name: string): Promise<void> {
  if (!autoAcceptEnabled() || reading.has(paneId)) return;

  reading.add(paneId);
  try {
    const pane = await herdr.read(paneId);
    const key = claimScreen(paneId, pane);
    if (key === null) return;

    await herdr.sendKeys(paneId, [key]);
    log(`chrome: allowed ${name} (${paneId}) by pressing ${key}`);
  } catch (err) {
    logError(`chrome: could not answer ${name} (${paneId})`, err);
  } finally {
    reading.delete(paneId);
  }
}
