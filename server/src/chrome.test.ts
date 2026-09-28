import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowKey, claimScreen, forgetPane } from './chrome.js';

/**
 * Answering the Claude in Chrome dialog without a human.
 *
 * A file of its own because this is the one thing the cockpit does at a prompt
 * on nobody's behalf, and both halves of it fail the same quiet way. The digit:
 * the option list is `Allow / Deny` as often as it is `Allow / Allow-all /
 * Deny`, since Claude Code renders the middle row only where that offer exists,
 * so the same number means opposite things on the two screens and a fixed
 * keystroke would deny about as often as it allowed — silently, because an
 * agent told no reports a refusal the human never gave. And the memory: nobody
 * is watching this send, so a key that does not take would be re-pressed every
 * heartbeat for as long as the agent stays blocked.
 *
 * `autoAcceptEnabled` is deliberately not covered. It is one `statSync` against
 * `~/.harness/chrome-autoaccept` in the real home directory, which these tests
 * may not touch, and existence-is-the-setting has no failure that could be
 * wrong rather than absent.
 */

const dialog = (...options: string[]): string =>
  ['⏺ Reading the page', '', 'Claude in Chrome wants to navigate on example.com', '  https://example.com/pricing', '', ...options].join('\n');

const LONG = ['❯ 1. Allow', '  2. Allow all actions on example.com for this session', '  3. Deny (esc)'];
const SHORT = ['❯ 1. Allow', '  2. Deny (esc)'];

// -- which digit -----------------------------------------------------------

test('THE ALLOW-ALL ROW IS TAKEN WHERE IT IS OFFERED', () => {
  assert.equal(allowKey(dialog(...LONG)), '2');
});

test('WITHOUT THAT ROW, 2 IS DENY — the digit is read, never assumed', () => {
  assert.equal(allowKey(dialog(...SHORT)), '1');
});

test('A DIALOG IN THE SCROLLBACK IS NOT ANSWERED AGAIN', () => {
  // The live region is what is below the last rule. An old dialog above it has
  // been answered already, and the agent blocked now is blocked at something
  // else — pressing its digit would answer THAT prompt in the human's name.
  const rule = '─'.repeat(60);
  const pane = [
    dialog(...LONG),
    rule,
    'Bash command',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, tell Claude what to do differently (esc)',
  ].join('\n');
  assert.equal(allowKey(pane), null);
});

test('the LAST dialog on screen is the one being answered', () => {
  const pane = [
    dialog(...LONG),
    '',
    '⏺ Navigated',
    '',
    'Claude in Chrome wants to take a screenshot',
    ...SHORT,
  ].join('\n');
  assert.equal(allowKey(pane), '1');
});

test('any other prompt is left alone', () => {
  const bash = ['Bash command', '', 'Do you want to proceed?', '❯ 1. Yes', '  2. No, tell Claude what to do differently (esc)'].join('\n');
  assert.equal(allowKey(bash), null);
  assert.equal(allowKey('❯ '), null);
});

// -- and only once ---------------------------------------------------------
// The send is optimistic, exactly as the blocked panel's keys are. What
// optimism cannot survive is the loop: this runs for every blocked agent on
// every resync, so a screen that does not change has to stop being answerable.

test('ONE KEYSTROKE PER SCREEN, or a key that does not take is pressed forever', () => {
  const pane = dialog(...LONG);
  assert.equal(claimScreen('w0:pA', pane), '2');
  // The same screen on the next beat: the press either landed or did not, and
  // re-pressing is the one thing that must not happen either way.
  assert.equal(claimScreen('w0:pA', pane), null);
  assert.equal(claimScreen('w0:pA', pane), null);
  forgetPane('w0:pA');
});

test('a dialog that genuinely asks again IS answered again', () => {
  // A second ask is never byte-identical to the first: the exchange in between
  // has grown the scrollback above it. Remembering the screen therefore bounds
  // the loop without ever refusing a real second question.
  const first = dialog(...LONG);
  const again = [first, '', '⏺ Navigated', '', 'Claude in Chrome wants to take a screenshot', ...SHORT].join('\n');
  assert.equal(claimScreen('w0:pB', first), '2');
  assert.equal(claimScreen('w0:pB', again), '1');
  forgetPane('w0:pB');
});

test('a screen with nothing to answer spends nothing', () => {
  // Claiming a non-dialog screen would leave the pane remembered as answered,
  // and the real dialog arriving on an otherwise identical screen would then be
  // skipped — the agent left blocked at a prompt this was turned on to clear.
  const idle = ['⏺ Reading the page', '', '❯ '].join('\n');
  assert.equal(claimScreen('w0:pC', idle), null);
  assert.equal(claimScreen('w0:pC', dialog(...LONG)), '2');
  forgetPane('w0:pC');
});

test('HERDR RECYCLES PANE IDS, so forgetting a pane releases its screen', () => {
  // Without this the next agent to inherit the id starts out holding the last
  // one's answered screen, and a dialog identical to it goes unanswered.
  const pane = dialog(...LONG);
  assert.equal(claimScreen('w0:pD', pane), '2');
  forgetPane('w0:pD');
  assert.equal(claimScreen('w0:pD', pane), '2');
  forgetPane('w0:pD');
});

test('two panes do not share a memory', () => {
  const pane = dialog(...LONG);
  assert.equal(claimScreen('w0:pE', pane), '2');
  assert.equal(claimScreen('w0:pF', pane), '2');
  forgetPane('w0:pE');
  forgetPane('w0:pF');
});
