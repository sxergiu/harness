import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sameAccount } from '@harness/shared';
import { statusOf } from './account.js';
import { decide } from './claudeFiles.js';
import { buildAgentDiff, within } from './diff.js';
import { announces, backoffMs, paneTookText, promptBoxHolds, staleServerWarning } from './herdr.js';
import { parse as parseRecent } from './history.js';
import { isOurs, merge, versionOf } from './herdrRules.js';
import { shouldOpen, type Running } from './instance.js';
import { admits, isLocal } from './origin.js';
import { parse } from './projects.js';
import { rulesFor } from './rules.js';
import { goalOf, slugForCwd, type Entry } from './transcript.js';
import { cropPanel, limitsOf } from './usage.js';

/**
 * The invariants that fail SILENTLY — a wrong answer here looks exactly like a
 * right one on screen, which is why they are the ones worth pinning. Every case
 * below is drawn from a failure that actually happened; the comments in the
 * modules themselves carry the full reasoning.
 *
 * Deliberately all pure functions over fixtures. Nothing here touches Herdr's
 * socket, the real `~/.claude` transcripts or the network, so the suite says
 * the same thing on a machine with no agents running.
 */

// -- invariant 14: the prompt box ------------------------------------------
// `agent.prompt` does not reliably submit, and the nudge must be content-free.

test('a submitted prompt leaves an empty box', () => {
  assert.equal(promptBoxHolds('some output\n❯ '), false);
});

test('text still in the box is detected', () => {
  assert.equal(promptBoxHolds('❯ fix the parser'), true);
});

test('a COLLAPSED PASTE is detected — the bug that caused double-sending', () => {
  // Claude Code renders a paste as this placeholder, which contains none of the
  // text we sent. The old head-match saw nothing and called it submitted.
  assert.equal(promptBoxHolds('❯ [Pasted text #1 +61 lines]'), true);
});

test('only the LAST prompt line counts — earlier ones are scrollback echoes', () => {
  // A submitted prompt is echoed as `❯ <text>`. Testing every line would call
  // this unsent and earn it a spurious Enter.
  assert.equal(promptBoxHolds('❯ earlier prompt\nsome output\n❯ '), false);
});

test('a slash-command menu below the box does not hide the box', () => {
  const pane = ['❯ /exit', '  /clear    Clear conversation', '  /exit     Exit', '  /help'].join('\n');
  assert.equal(promptBoxHolds(pane), true);
});

// -- the answer nobody gave ------------------------------------------------
// `sendText` used to send its Enter in the same call as the text. At a
// selection dialog the text is swallowed and that Enter commits the highlighted
// row, so a custom answer was dropped and an option the human never chose was
// recorded as theirs. Both fixtures are a live AskUserQuestion, read before and
// after sending "answer 4 with some words".

const question = (rows: string[]): string => [
  'Do you prefer cats or dogs?',
  '',
  ...rows,
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const unanswered = question(['❯ 1. Cats', '  2. Dogs', '  3. Type something.', '  4. Chat about this']);

test('a dialog that SWALLOWED the text is byte-identical — so no Enter may follow', () => {
  // Measured: md5 equal before and after, digits in the text included. Only real
  // key presses move that highlight; text arrives as a paste and is discarded.
  assert.equal(paneTookText(unanswered, unanswered), false);
});

test('the text row redrawing with the answer is what earns the Enter', () => {
  const typed = question(['  1. Cats', '  2. Dogs', '❯ 3. I like both equally', '  4. Chat about this']);
  assert.equal(paneTookText(unanswered, typed), true);
});

test('the signal is the SCREEN, not our words — a collapsed paste still counts', () => {
  // Same trap as `promptBoxHolds`: Claude Code shows a paste as a placeholder
  // holding none of what we sent, so looking for the text would refuse a send
  // that in fact landed.
  const pasted = question(['  1. Cats', '  2. Dogs', '❯ 3. [Pasted text #1 +61 lines]', '  4. Chat about this']);
  assert.equal(paneTookText(unanswered, pasted), true);
});

// -- the upgrade trap ------------------------------------------------------

test('a binary newer than the running server is reported', () => {
  const w = staleServerWarning('0.9.0', '0.7.5');
  assert.ok(w && w.includes('0.9.0') && w.includes('0.7.5'));
});

test('matching versions say nothing, and an unknown version is not a warning', () => {
  assert.equal(staleServerWarning('0.9.0', '0.9.0'), undefined);
  assert.equal(staleServerWarning(undefined, '0.9.0'), undefined);
  assert.equal(staleServerWarning('0.9.0', undefined), undefined);
});

// -- the retry that destroyed the log --------------------------------------
// A Herdr that is not running fails every retry with the same ENOENT, and `fail`
// reported each one. That is ~104 bytes a second into a file whose 1 MB cap
// stops it recording ANYTHING further, so an outage of under three hours left
// the next fault with nowhere to be written down.

test('a repeated identical failure is NOT re-announced — the flood that capped the log', () => {
  const down = { connected: false, error: 'connect ENOENT /home/u/.config/herdr/herdr.sock' };
  assert.equal(announces(down, { ...down }), false);
});

test('a DIFFERENT failure is announced, so one fault cannot mask the next', () => {
  const down = { connected: false, error: 'connect ENOENT /home/u/.config/herdr/herdr.sock' };
  assert.equal(announces(down, { connected: false, error: 'herdr ping timed out' }), true);
});

test('coming up and going down are both announced', () => {
  assert.equal(announces({ connected: false, error: 'gone' }, { connected: true }), true);
  assert.equal(announces({ connected: true }, { connected: false, error: 'gone' }), true);
});

test('the first state is always news, however unremarkable', () => {
  assert.equal(announces(null, { connected: true }), true);
  assert.equal(announces(null, { connected: false, error: 'gone' }), true);
});

test('backoff climbs and caps near the board heartbeat', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 20].map(backoffMs), [1000, 2000, 4000, 8000, 10000, 10000, 10000]);
});

// -- the request boundary --------------------------------------------------

test('local hosts are admitted on any port, so the Vite proxy keeps working', () => {
  assert.equal(admits('127.0.0.1:4373', 'http://127.0.0.1:4374'), true);
  assert.equal(admits('localhost:4373', 'http://localhost:4374'), true);
});

test('a missing Origin is admitted — curl and every non-browser client send none', () => {
  assert.equal(admits('127.0.0.1:4373', undefined), true);
});

test('a hostile origin is refused', () => {
  assert.equal(admits('127.0.0.1:4373', 'https://evil.example'), false);
});

test('DNS rebinding is refused by Host', () => {
  assert.equal(admits('evil.example', undefined), false);
});

test('a LOOKALIKE hostname is refused — the hole a substring check would leave', () => {
  assert.equal(isLocal('http://127.0.0.1.evil.com'), false);
  assert.equal(isLocal('http://localhost.evil.com'), false);
});

// -- invariant 10: a diff is a per-agent changelist -------------------------

// A tool RESULT arrives as a `user` entry, not an assistant one — results are
// fed back to the model. Reading the wrong side yields an empty changelist.
const patch = (path: string, lines: string[]): Entry => ({
  type: 'user',
  // camelCase. The deleted pipeline used `tool_use_result`, and reading that
  // spelling yields an empty changelist for every agent, forever.
  toolUseResult: {
    filePath: path,
    structuredPatch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
  },
} as unknown as Entry);

test('only this agent\'s own hunks appear in its changelist', () => {
  const diff = buildAgentDiff([patch('/repo/a.ts', ['+one'])], '/repo');
  assert.deepEqual(diff.files.map((f) => f.path), ['/repo/a.ts']);
});

test('two files touched by one agent both appear', () => {
  const diff = buildAgentDiff(
    [patch('/repo/a.ts', ['+one']), patch('/repo/b.ts', ['+two'])],
    '/repo',
  );
  assert.equal(diff.files.length, 2);
});

test('a string or array toolUseResult is not a write', () => {
  const notWrites = [
    { type: 'assistant', toolUseResult: 'command output' },
    { type: 'assistant', toolUseResult: ['a', 'b'] },
  ] as unknown as Entry[];
  assert.equal(buildAgentDiff(notWrites, '/repo').files.length, 0);
});

// -- the file route's containment check -------------------------------------
// `readAgentFile` serves any path resolving inside an agent's cwd to a browser
// with no auth, so a check that wrongly ACCEPTS serves the file and the panel
// renders it — indistinguishable on screen from a correct read. Same reasoning,
// and the same lookalike-prefix hole, as the origin test below.

test('the directory itself and anything under it are inside', () => {
  assert.equal(within('/repo/harness', '/repo/harness'), true);
  assert.equal(within('/repo/harness', '/repo/harness/server/src/board.ts'), true);
});

test('a LOOKALIKE sibling is outside — the hole a bare prefix test would leave', () => {
  assert.equal(within('/repo/harness', '/repo/harness-secrets/tokens.json'), false);
});

test('a walk out of the tree is outside once resolved', () => {
  assert.equal(within('/repo/harness', resolve('/repo/harness', '../../etc/passwd')), false);
});

test('a root that already ends in a separator does not grow a second one', () => {
  assert.equal(within('/', '/etc/passwd'), true);
});

// -- the one unstable field we parse ---------------------------------------
// `goalOf` reads an internal, version-unstable Claude Code attachment. The
// contract is that it validates everything and NEVER throws.

test('a well-formed goal is read', () => {
  const e = [{
    type: 'user',
    attachment: { type: 'goal_status', met: false, condition: 'tests pass' },
  }] as unknown as Entry[];
  assert.equal(goalOf(e)?.condition, 'tests pass');
});

test('malformed goal attachments return null rather than throwing', () => {
  const junk = [
    { type: 'user', attachment: { type: 'goal_status' } },      // no condition
    { type: 'user', attachment: { type: 'goal_status', condition: 42 } },
    { type: 'user', attachment: null },
    { type: 'user', attachment: 'not an object' },
    { type: 'user', attachment: [] },
    { type: 'user', message: { content: 'a bare string, which happens' } },
    { type: 'user' },
  ] as unknown as Entry[];
  for (const e of junk) {
    assert.doesNotThrow(() => goalOf([e]));
    assert.equal(goalOf([e]), null);
  }
});

// -- the transcript slug ---------------------------------------------------
// A wrong slug is not an error anywhere: the directory simply does not exist,
// and a missing transcript is a normal state (invariant 9). So the whole
// symptom is an agent whose feed and changelist are permanently empty, which
// is the reason this is pinned rather than left to the one place it is read.

test('a POSIX cwd slugs as Claude Code writes it on disk', () => {
  assert.equal(slugForCwd('/Users/x/repos/web.app'), '-Users-x-repos-web-app');
  assert.equal(slugForCwd('/Users/x/.harness'), '-Users-x--harness');
});

test('a Windows cwd loses its drive colon and backslashes', () => {
  assert.equal(slugForCwd('C:\\Users\\x\\repos\\foo'), 'C--Users-x-repos-foo');
});

test('characters Claude Code can keep are kept — underscores and spaces', () => {
  // Widening this to every non-alphanumeric is a claim about macOS paths that
  // nobody has measured, and it would silently move every existing slug.
  assert.equal(slugForCwd('/Users/x/my_repo v2'), '-Users-x-my_repo v2');
});

// -- the usage panel -------------------------------------------------------

test('cropPanel cuts at the LAST rule, so the agent\'s own output is not returned as usage', () => {
  // The dialog is drawn below a full-width rule with the transcript still
  // visible above it; returning the pane verbatim returned the agent's own
  // output as "usage".
  const rule = '─'.repeat(40);
  const pane = ['agent said something', rule, 'Current session', '50% used'].join('\n');
  const cropped = cropPanel(pane);
  assert.ok(!cropped.includes('agent said something'));
  assert.ok(cropped.includes('Current session'));
});

test('a panel taller than the pane scrolls its rule away, and that is not a failure', () => {
  const pane = ['Current session', '50% used'].join('\n');
  assert.ok(cropPanel(pane).includes('Current session'));
});

test('a status line is NOT the usage panel — "% used" alone must not match', () => {
  // `Opus 5 (1M context) | Context: 8% used` made the old detector fire on a
  // pane with no dialog open and press escape at a working agent.
  assert.equal(limitsOf('Opus 5 (1M context) | Context: 8% used').length, 0);
});

test('the two limit bars are read', () => {
  const panel = [
    'Current session', '45% used', 'Resets in 2h',
    'Current week', '12% used', 'Resets Monday',
  ].join('\n');
  assert.equal(limitsOf(panel).length, 2);
});

// -- git delegation --------------------------------------------------------
// An agent wrongly told it may push looks exactly like one that was not, on
// every screen the cockpit has. The first sign of a mistake here is a commit in
// a repository nobody delegated.

test('an undelegated checkout is told nothing about git', () => {
  assert.equal(rulesFor('RULES', false), 'RULES');
});

test('a delegated checkout gets the amendment, scoped to this checkout', () => {
  const rules = rulesFor('RULES', true);
  assert.ok(rules.startsWith('RULES'));
  assert.ok(rules.includes('Exception to rule 1'));
  assert.ok(rules.includes('extends to any other checkout.'));
});

/**
 * A store keyed the way `projects.ts` writes one, which is `resolve()`d — the one
 * form its own guard admits. The key has to be built rather than written out,
 * because `/a` is absolute on POSIX and is NOT on Windows, where `resolve`
 * answers `\a`: the literal was dropped for being relative before its value was
 * ever looked at, which failed the grant below and passed the `"yes"` refusal
 * above for entirely the wrong reason.
 */
const stored = (gitDelegated: unknown): string =>
  JSON.stringify({ version: 1, checkouts: { [resolve('/a')]: { gitDelegated } } });

test('a store it cannot make sense of yields NO grants, and never throws', () => {
  // The silent half. A bad read that answers `true` looks identical on the
  // board to a real grant, and the first sign of it is a commit in a repository
  // nobody delegated — so every one of these must fail toward refusing.
  assert.equal(parse('{"version":2,"checkouts":{"/a":{"gitDelegated":true}}}').size, 0);
  assert.equal(parse('{"version":1}').size, 0);
  assert.equal(parse('{"version":1,"checkouts":null}').size, 0);
  assert.equal(parse('[{"path":"/a"}]').size, 0);
  // Truthy but not `true`, and a relative key a resolved lookup can never match.
  assert.equal(parse(stored('yes')).size, 0);
  assert.equal(parse('{"version":1,"checkouts":{"repos/a":{"gitDelegated":true}}}').size, 0);
});

test('a store it CAN read still grants — the refusals above are not just a broken parse', () => {
  assert.equal(parse(stored(true)).size, 1);
});

// -- invariant 15: a second invocation must not pile up tabs ---------------
// This has been "fixed" twice and come back twice, both times because the guard
// looked right in the file it was written in. It fails in the only way that
// matters to whoever is watching: silently, one tab at a time, minutes after
// the command that caused it.

const instance = (over: Partial<Running>): Running =>
  ({ pid: 1, port: 4373, page: true, viewers: 0, ...over });

test('a DEV instance is never opened automatically, however empty it looks', () => {
  // `tsx watch` respawns the server into this check on every save, and `viewers`
  // legitimately reads 0 for the second after a restart. One touch of a server
  // file measured seven tabs. No delay fixes it — the browser's own retry is
  // 1000ms, so any wait short enough to keep the command fast is a coin flip.
  assert.equal(shouldOpen(instance({ page: false, viewers: 0 })), false);
});

test('a built cockpit nobody is looking at IS opened — that is the feature', () => {
  assert.equal(shouldOpen(instance({ page: true, viewers: 0 })), true);
});

test('a cockpit already on screen gets no second copy', () => {
  // `open` gives you a new tab rather than the one you already have.
  assert.equal(shouldOpen(instance({ page: true, viewers: 1 })), false);
});

// -- RECENT survives its own format change --------------------------------
// A cache, so an unreadable one is only ever a lost row — but a row that
// arrives without a paneId or a name renders as a blank entry that cannot be
// clicked or dismissed, and nothing about it says where it came from.

test('the pre-version bare array is still read, not thrown away', () => {
  const rows = parseRecent('[{"paneId":"w2:pA","name":"old"}]');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.paneId, 'w2:pA');
});

test('a version it does not know is discarded rather than guessed at', () => {
  assert.equal(parseRecent('{"version":99,"rows":[{"paneId":"w2:pA","name":"x"}]}').length, 0);
});

test('rows missing the two fields the column cannot render without are dropped', () => {
  const rows = parseRecent(JSON.stringify({
    version: 1,
    rows: [{ paneId: 'w2:pA', name: 'good' }, { name: 'no pane' }, { paneId: 'w2:pB' }, null, 'nonsense'],
  }));
  assert.deepEqual(rows.map((r) => r.name), ['good']);
});

// -- installing over the human's own files ---------------------------------
// `harness init` writes into ~/.claude. An overwrite of someone's own planner
// or command file is silent, and theirs to discover later.

test('a missing file is written, and an identical one is left alone', () => {
  assert.equal(decide(null, 'shipped', false), 'wrote');
  assert.equal(decide('shipped', 'shipped', false), 'identical');
});

test('a file the human has changed is KEPT unless forced', () => {
  assert.equal(decide('mine', 'shipped', false), 'kept');
  assert.equal(decide('mine', 'shipped', true), 'wrote');
});

// -- invariant 17: the Herdr detection override ----------------------------
// A local manifest shadows the remote one entirely. Herdr ignores a malformed
// override with a warning nobody sees and silently keeps the remote — which
// puts the agent straight back to reading `idle` while it waits on a dialog.

test('the rule lands exactly once and the remote manifest survives whole', () => {
  const remote = 'version = "2026.09.11.1"\n\n[[rules]]\nid = "a"\n';
  const block = '[[rules]]\nid = "chrome_extension_permission_prompt"\n';
  const once = merge(remote, block);
  assert.equal(once.split('id = "chrome_extension_permission_prompt"').length - 1, 1);
  assert.ok(isOurs(once));
  assert.ok(once.includes('id = "a"'), 'the remote manifest must survive the merge whole');
});

test('the remote version rides along verbatim, which is what staleness is measured on', () => {
  // Herdr reports this field back as `manifest: <path> <version>`, so the
  // merged file has to carry the remote's own value rather than one of ours.
  const merged = merge('version = "2026.09.11.1"\n', '[[rules]]\n');
  assert.equal(versionOf(merged), '2026.09.11.1');
});

test('a manifest we did not write is not mistaken for ours', () => {
  assert.equal(isOurs('version = "2026.09.11.1"\n[[rules]]\n'), false);
});

// -- the account switch ----------------------------------------------------
// A switch is decided entirely on this parse. A loose one reports a login that
// never happened: the pane the human is still using gets closed, the panel
// shows the new account, and every request keeps going out on the old one.

test('the real payload parses, and the email survives it', () => {
  // Measured from `claude auth status --json` on a signed-in machine.
  const out = statusOf(JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
    email: 'someone@example.com', orgId: 'o-1', orgName: "someone's Organization",
    subscriptionType: 'pro',
  }));
  assert.equal(out?.current?.email, 'someone@example.com');
  assert.equal(out?.current?.subscriptionType, 'pro');
  assert.equal(out?.current?.orgId, 'o-1', 'the disambiguator must survive the parse');
});

test('TWO ACCOUNTS ON ONE ADDRESS are two accounts', () => {
  // A personal Pro and an organization seat under the same address. Keying the
  // known list on the email alone made the second REPLACE the first, so the
  // list stayed at one row and a second account could not be added at all.
  const pro = { email: 'a@b.com', orgId: 'org-personal', orgName: 'a', subscriptionType: 'pro' };
  const seat = { email: 'a@b.com', orgId: 'org-acme', orgName: 'Acme', subscriptionType: 'max' };
  assert.equal(sameAccount(pro, seat), false);
  assert.equal(sameAccount(pro, { ...pro }), true);
});

test('SIGNED OUT is an answer, not a failure', () => {
  // The distinction the whole panel rests on: this is `available: true` with
  // nobody signed in, where a null below is a `claude` that did not answer.
  assert.deepEqual(statusOf('{"loggedIn":false}'), { current: null });
});

test('a signed-in answer with no email is not signed in', () => {
  assert.equal(statusOf('{"loggedIn":true}'), null);
  assert.equal(statusOf('{"loggedIn":true,"email":""}'), null);
});

test('anything that is not the shape we know answers null', () => {
  assert.equal(statusOf(''), null, 'not on PATH');
  assert.equal(statusOf('Error: not logged in'), null, 'an error printed to stdout');
  assert.equal(statusOf('{"loggedIn":"yes"}'), null, 'truthy is not a boolean');
  assert.equal(statusOf('null'), null);
});
