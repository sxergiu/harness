import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { aliasRuns, bashMode, sameAccount } from '@harness/shared';
import { parse as parseAccounts, rowFor, statusOf } from './account.js';
import { dormantSession, seedCwd } from './board.js';
import {
  HOLD_MS, decide, grantOf, holdFor, mayTrust, pinAction, settleAction, trustKey,
} from './claudeFiles.js';
import { buildAgentDiff, within } from './diff.js';
import {
  announces, backoffMs, paneTookText, promptBoxHolds, shellTail, staleServerWarning, type PaneInfo,
} from './herdr.js';
import { parse as parseRecent } from './history.js';
import { isOurs, merge, versionOf } from './herdrRules.js';
import { shouldOpen, type Running } from './instance.js';
import { admits, isLocal } from './origin.js';
import { parse } from './projects.js';
import { argsFor, DEFAULT_RULES, flatten, modelFrom, resumeArgs, rulesFor } from './rules.js';
import {
  aliasDisproven, contextOf, effortDisproven, effortOf, feedTurns, goalOf, modelOf, slugForCwd,
  windowFor, type Entry,
} from './transcript.js';
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

// -- the suite itself ------------------------------------------------------
// `npm test` names its files outright: node's own glob support arrived after
// the version `engines` declares, and a POSIX shell expanding `*` for us is
// exactly what broke the build scripts on Windows. Handing node the DIRECTORY
// instead is worse than either — measured here, `--test server/src` ran the
// whole directory as one opaque case and reported `tests 1, pass 1`, green and
// meaningless.
//
// So the list is maintained by hand, and this is what stops a hand-maintained
// list from silently going short. A test file nobody runs is the purest form of
// the failure this suite exists for: it reports nothing, and reporting nothing
// is indistinguishable from passing.

test('EVERY TEST FILE IS NAMED IN `npm test` — one nobody runs says nothing', () => {
  const root = new URL('../../', import.meta.url);
  const script = (
    JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as
      { scripts: Record<string, string> }
  ).scripts.test;

  const onDisk = readdirSync(new URL('server/src/', root))
    .filter((name) => name.endsWith('.test.ts'))
    .sort();

  // Compared as the script spells them — forward slashes, since that is what is
  // written in the manifest on every platform — never as a resolved path.
  const missing = onDisk.filter((name) => !script.includes(`server/src/${name}`));
  assert.deepEqual(missing, [], `not run by \`npm test\`: ${missing.join(', ')}`);
  // And the suite is plural, which is the state this guard was added to keep.
  assert.ok(onDisk.length >= 2);
});

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

test('a stalled `! cmd` is detected — bash mode draws the box with no `❯`', () => {
  // Measured: the box redraws as `!` + NBSP at column 0, with a hint below it.
  const pane = ['❯ earlier prompt', 'reply', '─────', '!  echo x', '─────', '  ! for shell mode'].join('\n');
  assert.equal(promptBoxHolds(pane), true);
});

test('an echoed `!` run above an empty box is history, not the box', () => {
  const pane = ['!  echo x', '  ⎿  x', '─────', '❯ ', '─────'].join('\n');
  assert.equal(promptBoxHolds(pane), false);
});

// -- a bash-mode run while it runs -----------------------------------------
// The transcript records a run only once it is over, so the box that started
// it reads the pane meanwhile. A wrong cut shows another run's output, or the
// agent's reply, as this one's.

const running = [
  '!  echo old',
  '  ⎿  old',
  '● earlier reply',
  '!  for i in 1 2 3; do echo line$i; sleep 1; done',
  // The separator is a space then an NBSP — measured, and a plain-space cut
  // left the NBSP on the first line.
  '  ⎿  line1',
  '     line2',
  '       indented',
  '     (2s)',
  '     (ctrl+b to run in background)',
  '─────',
  '❯ ',
].join('\n');

test('the tail is the LAST matching echo, cut at the box, without timers', () => {
  assert.deepEqual(shellTail(running, 'for i in 1 2 3; do echo line$i; sleep 1; done'), [
    'line1', 'line2', '  indented',
  ]);
});

test('an older run of a different command is not this one', () => {
  assert.deepEqual(shellTail(running, 'echo old'), ['old']);
  assert.equal(shellTail(running, 'echo never-ran'), null);
});

test('a multi-line command\'s echo is skipped, and Running… is not output', () => {
  const pane = ['!  echo first', '  echo second', '  ⎿  Running…', '─────'].join('\n');
  assert.deepEqual(shellTail(pane, 'echo first'), []);
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
//
// EVERY FIXTURE HERE IS BUILT, NEVER WRITTEN AS A LITERAL. `within` compares
// against the platform separator, which is right for production — both its
// arguments come from `realpathSync`, so on Windows they are backslash paths —
// and a POSIX literal therefore fails containment there for a reason that has
// nothing to do with what is being tested. Measured: the two cases below that
// expect `true` failed the Windows leg outright, and the lookalike PASSED, since
// a comparison that matches nothing also matches nothing it should refuse. That
// is the `projects.json` fixture bug of 0.2.0 by the same door.
const repo = resolve('/repo/harness');

test('the directory itself and anything under it are inside', () => {
  assert.equal(within(repo, repo), true);
  assert.equal(within(repo, join(repo, 'server', 'src', 'board.ts')), true);
});

test('a LOOKALIKE sibling is outside — the hole a bare prefix test would leave', () => {
  assert.equal(within(repo, join(`${repo}-secrets`, 'tokens.json')), false);
});

test('a walk out of the tree is outside once resolved', () => {
  assert.equal(within(repo, resolve(repo, '../../etc/passwd')), false);
});

test('a root that already ends in a separator does not grow a second one', () => {
  // `/` on POSIX, `C:\` on Windows — the one path that already carries its
  // separator, and so the one that would grow a second. `resolve` answers it
  // directly; `parse().root` would too and cannot be used, since this file
  // already imports a `parse` of its own.
  const root = resolve('/');
  assert.equal(within(root, join(root, 'etc', 'passwd')), true);
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

// -- bash-mode runs in the feed --------------------------------------------
// Two `user` entries per run, measured. Read as ordinary messages, one run
// showed as two turns of raw XML.

const user = (content: string): Entry => ({ type: 'user', message: { content } }) as unknown as Entry;
const reply = (text: string): Entry =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as Entry;

test('one run is ONE turn holding one shell entry, with the reply under it', () => {
  const turns = feedTurns([
    user('<bash-input> echo hi</bash-input>'),
    user('<bash-stdout>hi</bash-stdout><bash-stderr></bash-stderr>'),
    reply('it printed hi'),
  ], '/repo');
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].entries[0], {
    kind: 'shell', command: 'echo hi', output: { stdout: 'hi', stderr: '' },
  });
  assert.equal(turns[0].entries[1].kind, 'text');
});

test('a queued run (no leading space), a multi-line one and stderr all read', () => {
  const [queued, multi] = feedTurns([
    user('<bash-input>echo q</bash-input>'),
    user('<bash-stdout>q\r\n</bash-stdout><bash-stderr></bash-stderr>'),
    user('<bash-input> echo a\necho b</bash-input>'),
    user('<bash-stdout></bash-stdout><bash-stderr>ls: nope\n</bash-stderr>'),
  ], '/repo');
  assert.deepEqual(queued.entries[0], { kind: 'shell', command: 'echo q', output: { stdout: 'q', stderr: '' } });
  assert.deepEqual(multi.entries[0], {
    kind: 'shell', command: 'echo a\necho b', output: { stdout: '', stderr: 'ls: nope' },
  });
});

test('a run with no output yet, and output with no run, never open a turn of XML', () => {
  const pending = feedTurns([user('<bash-input> sleep 9</bash-input>')], '/repo');
  assert.deepEqual(pending[0].entries[0], { kind: 'shell', command: 'sleep 9', output: null });
  const orphan = feedTurns([user('<bash-stdout>stray</bash-stdout><bash-stderr></bash-stderr>')], '/repo');
  assert.deepEqual(orphan[0].entries, [{ kind: 'system', text: 'stray' }]);
});

test('a block runs as itself, a PowerShell one inside bash quotes, anything else not at all', () => {
  assert.equal(bashMode('  npm test \n', 'bash'), 'npm test');
  // Bash reads `'a''b'` as `ab`: a doubled quote would vanish before PowerShell.
  assert.equal(bashMode(`Write-Output 'it'`, 'powershell'), `powershell -NoProfile -Command 'Write-Output '\\''it'\\'''`);
  assert.equal(bashMode('$ npm test\nok', 'console'), null);
  assert.equal(bashMode('const x = 1', 'ts'), null);
  assert.equal(bashMode('   ', 'sh'), null);
  assert.equal(bashMode('ls', null), null);
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

// -- the model an agent runs on --------------------------------------------
// Every wrong answer here is a plausible one: an agent started on a model
// nobody chose looks exactly like one started right, and a window measured
// against the wrong model is a percentage that is simply too low.

test('no stored model means no flag at all', () => {
  assert.deepEqual(argsFor('RULES', null), ['--append-system-prompt', 'RULES']);
  assert.deepEqual(
    argsFor('RULES', 'sonnet[1m]'),
    ['--append-system-prompt', 'RULES', '--model', 'sonnet[1m]'],
  );
});

test('the system prompt carries no straight double quote', () => {
  // Windows PowerShell 5.1 does not escape one inside a native argument, so it
  // ends the argument there and drops everything after — the git amendment
  // included — with nothing anywhere saying so.
  const [, prompt] = argsFor(rulesFor(DEFAULT_RULES, true), null);
  assert.ok(!prompt.includes('"'));
  assert.ok(prompt.endsWith('Nothing here extends to any other checkout.'));
  assert.equal(flatten('a ("was X, now Y") b "c'), 'a (“was X, now Y”) b ”c');
});

test('a blank or newline-bearing model file is no choice', () => {
  assert.equal(modelFrom('  \n '), null);
  // Invariant 11: Herdr fails the whole `agent.start` on a newline, with an
  // encoding error that says nothing about models.
  assert.equal(modelFrom('opus\nsonnet'), null);
  assert.equal(modelFrom(' opus[1m]\n'), 'opus[1m]');
});

test('a hold waits for the write, then restores, and gives up rather than guessing', () => {
  const hold = { want: 'haiku', restoreTo: 'opus[1m]', expires: 100 };
  // The switch is sent and the CLI has not written yet. Restoring now puts the
  // old alias back BEFORE the new one arrives, and the file then keeps the new
  // one for good — the exact bug the hold exists to prevent, and invisible.
  assert.equal(settleAction('opus[1m]', hold, 0), 'wait');
  assert.equal(settleAction('haiku', hold, 0), 'restore');
  // A `/model` queued at a working agent may never land — the human may have
  // cleared the session under it. Writing anyway would rewrite a default
  // against a switch that never happened.
  assert.equal(settleAction('opus[1m]', hold, 100), 'give-up');
  // The human editing settings by hand mid-hold is not the write we are
  // waiting for, and is left alone until the hold expires.
  assert.equal(settleAction('sonnet', hold, 0), 'wait');
});

test('a second switch restores what the FIRST one found, not what it found', () => {
  const first = holdFor(undefined, 'haiku', 'opus[1m]', 0);
  assert.deepEqual(first, { want: 'haiku', restoreTo: 'opus[1m]', expires: HOLD_MS });
  // Two agents switched inside one window are two writes to one key. By the
  // time the second is sent the file may already say `haiku`, and restoring to
  // that would leave the first agent's alias standing as the machine default —
  // which is the whole thing being defended against, arrived at from inside.
  assert.deepEqual(
    holdFor(first!, 'sonnet', 'haiku', 0),
    { want: 'sonnet', restoreTo: 'opus[1m]', expires: HOLD_MS },
  );
});

test('switching to what the file already says takes no hold', () => {
  // There is nothing to put back, and a hold would restore the alias over
  // itself on the next heartbeat.
  assert.equal(holdFor(undefined, 'opus[1m]', 'opus[1m]', 0), null);
  // Settings naming no model at all is a real state, and the restore for it is
  // to remove the key rather than to write the string "null" into it.
  assert.deepEqual(holdFor(undefined, 'haiku', null, 0)?.restoreTo, null);
});

test('a pin asserts only on drift, and an unpinned default is left alone', () => {
  // No pin is every install until somebody sets one, and it must stay exactly
  // the behaviour that shipped: the file is whatever anything else made it.
  assert.equal(pinAction(null, 'haiku'), 'leave');
  assert.equal(pinAction(null, null), 'leave');
  // Drift is the whole signal. This is what a `/model` typed in a pane leaves
  // behind, and what left the file on `haiku` while every agent ran opus[1m] —
  // silent, because nothing but the context meter's denominator reads it.
  assert.equal(pinAction('opus[1m]', 'haiku'), 'write');
  // Settings naming no model at all is a real state, and a pin is what fills it.
  assert.equal(pinAction('opus[1m]', null), 'write');
  // Settled leaves. This runs on every resync against a file every running
  // agent also writes, so writing here unconditionally would be a heartbeat
  // loop over Claude Code's own settings — invisible until it clobbered
  // something a concurrent write had just put there.
  assert.equal(pinAction('opus[1m]', 'opus[1m]'), 'leave');
});

test('trust is keyed the way Claude Code keys it, and never reaches the home tree', () => {
  // A key in any other spelling is one Claude Code never reads, so the dialog
  // comes up anyway with nothing saying the grant missed.
  assert.equal(trustKey('c:\\Users\\me\\repo\\', 'win32'), 'C:/Users/me/repo');
  assert.equal(trustKey('C:\\', 'win32'), 'C:/');
  assert.equal(trustKey('/Users/me/repo/', 'darwin'), '/Users/me/repo');
  assert.equal(trustKey('/', 'darwin'), '/');

  assert.equal(mayTrust('C:\\Users\\me\\repos\\x', 'C:\\Users\\me', 'win32'), true);
  // Trust is inherited, so home or any ancestor of it would trust everything.
  assert.equal(mayTrust('c:/users/ME', 'C:\\Users\\me', 'win32'), false);
  assert.equal(mayTrust('C:\\', 'C:\\Users\\me', 'win32'), false);
  assert.equal(mayTrust('/Users', '/Users/me', 'darwin'), false);
  assert.equal(mayTrust('/', '/Users/me', 'darwin'), false);
  assert.equal(mayTrust('/Users/me2', '/Users/me', 'darwin'), true);
});

test('the tool grant only appends, and keeps everything of the human\'s own', () => {
  const tools = ['Write', 'Edit', 'Bash'];
  const mine = {
    theme: 'dark',
    permissions: { allow: ['Read(src/**)', 'Bash(*)'], deny: ['Bash(rm:*)'], defaultMode: 'default' },
  };
  const grant = grantOf(mine, tools)!;
  // `Bash(*)` is all of Bash already, and a narrowed deny is a deliberate
  // restriction rather than something overriding the grant.
  assert.deepEqual(grant.missing, ['Write', 'Edit']);
  assert.deepEqual(grant.overridden, []);
  assert.deepEqual(grant.next, {
    theme: 'dark',
    permissions: {
      allow: ['Read(src/**)', 'Bash(*)', 'Write', 'Edit'],
      deny: ['Bash(rm:*)'],
      defaultMode: 'default',
    },
  });
  assert.deepEqual(grantOf(grant.next, tools)!.missing, []);

  assert.deepEqual(grantOf({ permissions: { ask: ['Edit'] } }, tools)!.overridden, ['Edit']);
  assert.deepEqual(grantOf({}, tools)!.next, { permissions: { allow: tools } });
  // A shape we would have to guess about is never written over.
  assert.equal(grantOf({ permissions: { allow: 'Bash' } }, tools), null);
  assert.equal(grantOf([], tools), null);
});

test('the model is read past a subagent, whose requests are its own', () => {
  const entries: Entry[] = [
    { type: 'assistant', message: { model: 'claude-opus-5' } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5' } },
  ];
  assert.equal(modelOf(entries), 'claude-opus-5');
});

test('the effort is read off the same request as the model, never an older one', () => {
  const entries: Entry[] = [
    { type: 'assistant', effort: 'high', message: { model: 'claude-opus-5' } },
    // Measured: a real `haiku` request records no effort at all. Reading on
    // past it answers `high` — the level of a request that is no longer the
    // newest — and the header would show it beside the newer model's name.
    { type: 'assistant', message: { model: 'claude-haiku-4-5' } },
  ];
  assert.equal(effortOf(entries), null);
  assert.equal(effortOf(entries.slice(0, 1)), 'high');
});

/** One turn: the human's prompt at `iso`, and a request answering it a second later. */
const turnAt = (iso: string, request: Omit<Entry, 'type'>): Entry[] => [
  { type: 'user', timestamp: iso, message: { content: 'go on' } },
  { type: 'assistant', timestamp: new Date(Date.parse(iso) + 1000).toISOString(), ...request },
];

test('a level asked for is answered by the cap as surely as by a refusal', () => {
  const at = (iso: string, effort?: string): Entry[] =>
    turnAt(iso, { effort, message: { model: 'claude-opus-5' } });
  const asked = Date.parse('2026-09-29T12:00:00.000Z');

  // Same ordering rule as the alias: a turn opened before the ask is at the old
  // level by definition, and reading it as evidence would drop every switch the
  // instant it was made.
  assert.equal(effortDisproven(at('2026-09-29T11:59:59.000Z', 'high'), 'max', asked), false);
  // The ask honoured.
  assert.equal(effortDisproven(at('2026-09-29T12:00:01.000Z', 'max'), 'max', asked), false);
  // Claude Code CAPS the level at the model's ceiling and records what it
  // allowed. That is an answer, not a disagreement to argue with — left
  // standing, the header would report a level no request has ever run at.
  assert.equal(effortDisproven(at('2026-09-29T12:00:01.000Z', 'high'), 'max', asked), true);
  // ABSENCE IS THE MEASUREMENT, which is the one place this parts company with
  // `aliasDisproven`: a model with no effort level records none, so a request
  // carrying nothing says the level is gone rather than saying nothing at all.
  assert.equal(effortDisproven(at('2026-09-29T12:00:01.000Z'), 'high', asked), true);
  // Nothing to check against still proves nothing — a fresh session, a pruned
  // transcript, an entry with no usable timestamp.
  assert.equal(effortDisproven([], 'high', asked), false);
  assert.equal(
    effortDisproven([{ type: 'assistant', message: { model: 'claude-opus-5' } }], 'high', asked),
    false,
  );
});

test('a switch queued behind a turn is not refused by the rest of that turn', () => {
  // A `/model` or `/effort` sent to a busy agent waits for the turn to end, and
  // every request the turn makes meanwhile is AFTER the ask and on the old
  // values. Counting those dropped the switch while it was still queued.
  const asked = Date.parse('2026-09-29T12:00:00.000Z');
  const busy = turnAt('2026-09-29T11:59:00.000Z', {});
  busy[1] = {
    type: 'assistant', timestamp: '2026-09-29T12:00:05.000Z', effort: 'high',
    message: { model: 'claude-opus-5' },
  };
  assert.equal(aliasDisproven(busy, 'sonnet', asked), false);
  assert.equal(effortDisproven(busy, 'max', asked), false);
});

test('the 1M window is refused to a session not on that model', () => {
  // The settings alias is machine-wide and true of at most some agents, since a
  // `/model` typed at one rewrites it for all of them.
  assert.equal(windowFor('claude-sonnet-5', 'opus[1m]'), 200_000);
  assert.equal(windowFor('claude-opus-5', 'opus[1m]'), 1_000_000);
  assert.equal(windowFor('claude-opus-5', 'opus'), 200_000);
  // Nothing read yet leaves the alias standing alone, as it did before there
  // was anything to check it against.
  assert.equal(windowFor(null, 'opus[1m]'), 1_000_000);
});

test('an alias names a family, which is what refines a measured model', () => {
  // The header reads this for what `windowFor` short-circuits past — a non-1M
  // alias, which never reaches the family test through the window at all. Both
  // wrong answers are silent: a `1M` marker on a session that does not have one,
  // or an exact model id shown for a family the pane is no longer running.
  assert.equal(aliasRuns('opus', 'claude-opus-5'), true);
  assert.equal(aliasRuns('opus[1m]', 'claude-opus-5'), true);
  assert.equal(aliasRuns('sonnet', 'claude-opus-5'), false);
  // A real haiku id is dated, so the family is a substring of it and not an
  // equality — measured `claude-haiku-4-5-20251001`.
  assert.equal(aliasRuns('haiku', 'claude-haiku-4-5-20251001'), true);
  // Nothing measured contradicts the alias, so a fresh agent is not mid-switch.
  assert.equal(aliasRuns('sonnet', null), true);
});

test('ONLY A REQUEST AFTER THE ASK CAN DISPROVE IT, which is what makes the label current', () => {
  const at = (iso: string, model: string): Entry[] => turnAt(iso, { message: { model } });
  const asked = Date.parse('2026-09-29T12:00:00.000Z');

  // The request BEFORE a switch is of the old model by definition. Reading it as
  // evidence calls every switch refused the instant it is made, which puts the
  // header back to showing the model the agent has just been moved off.
  assert.equal(
    aliasDisproven(at('2026-09-29T11:59:58.000Z', 'claude-opus-5'), 'sonnet', asked),
    false,
  );
  // A turn opened after it, on another family: the ask did not take — refused in
  // the pane, or overridden by a `/model` typed there. Left standing, it would be
  // reported as the current model for the life of the pane.
  assert.equal(
    aliasDisproven(at('2026-09-29T12:00:01.000Z', 'claude-opus-5'), 'sonnet', asked),
    true,
  );
  // The ask honoured. `[1m]` is invisible in a transcript, so the family is all
  // there is to agree with, and disagreeing here would drop the only record that
  // the session has the wider window.
  assert.equal(
    aliasDisproven(at('2026-09-29T12:00:01.000Z', 'claude-opus-5'), 'opus[1m]', asked),
    false,
  );
  // Nothing to check against proves nothing: a fresh session, a pruned
  // transcript, an entry with no usable timestamp. The claim stands.
  assert.equal(aliasDisproven([], 'sonnet', asked), false);
  assert.equal(
    aliasDisproven([{ type: 'assistant', message: { model: 'claude-opus-5' } }], 'sonnet', asked),
    false,
  );
});

test('the window follows what is KNOWN of the pane, and the family check binds it too', () => {
  const entries: Entry[] = [
    { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 50_000 } } },
  ];
  // A known alias — what the pane was switched to, or started with — answers on
  // its own, which is also what keeps this test off `~/.claude`: the settings
  // file is consulted only where nothing is known, and `??` never gets there.
  assert.equal(contextOf(entries, 'sonnet[1m]')?.window, 1_000_000);
  assert.equal(contextOf(entries, 'sonnet[1m]')?.tokens, 50_000);
  // THE KNOWN ALIAS IS NOT PRIVILEGED. It was the wider of two claims that
  // granted 1M to sessions plainly not on that model; one claim resolved by
  // precedence still has to survive the same family check, or the cockpit's own
  // `--model` becomes a way to widen any window on the board.
  assert.equal(contextOf(entries, 'opus[1m]')?.window, 200_000);
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

// -- the per-account usage cache -------------------------------------------
// Hung on the account row, so the account you switch AWAY from keeps the last
// numbers it had. Both failures below leave a row that still renders, with the
// cached reading simply absent — which is indistinguishable from an account
// that has never been read.

test('A CAPTURE CARRIES OVER WHAT THE CLI CANNOT REPORT', () => {
  const identity = { email: 'a@b.com', orgId: 'o-1', orgName: 'Acme', subscriptionType: 'pro' };
  const prior = {
    ...identity,
    label: 'work',
    usage: { limits: [{ label: 'session', percent: 12 }], at: '2026-09-28T10:00:00.000Z' },
  };
  // `capture` runs every two seconds while a login is open. Rebuilding from the
  // identity alone erases both of these within a tick of learning them.
  assert.deepEqual(rowFor(identity, prior).usage, prior.usage);
  assert.equal(rowFor(identity, prior).label, 'work');
  // A never-seen account has neither, and must not invent them.
  assert.equal(rowFor(identity, undefined).usage, null);
  assert.equal(rowFor(identity, undefined).label, null);
});

test('a stored reading survives the parse, and a malformed one costs only itself', () => {
  const row = (usage: unknown): string =>
    JSON.stringify({ version: 2, accounts: [{ email: 'a@b.com', orgId: 'o-1', label: null, usage }] });

  const good = { limits: [{ label: 'week', percent: 71 }], at: '2026-09-28T10:00:00.000Z' };
  assert.deepEqual(parseAccounts(row(good))[0]?.usage, good);

  // Every one of these must answer null rather than throw. `parse` runs inside
  // the constructor's try, so a throw here does not cost a percentage — it
  // empties the WHOLE list, labels and all, and the panel just shows fewer rows.
  for (const bad of [null, 'nonsense', 42, {}, { at: 1, limits: [] }, { at: 'x', limits: 'no' },
    { at: 'x', limits: [{ label: 'week', percent: 'lots' }] }]) {
    const parsed = parseAccounts(row(bad));
    assert.equal(parsed.length, 1, 'the row itself must survive a reading it cannot read');
    assert.equal(parsed[0]?.usage, null);
  }
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

// -- the space's directory -------------------------------------------------
// The seed is read once and then pinned for the life of the space, so a wrong
// answer here is not a wrong dir for one heartbeat: it is where every agent
// that space ever starts gets launched, and it looks exactly like a right one
// until one lands in another repo.

const paneAt = (id: string, cwd: string, rest: Partial<PaneInfo> = {}): PaneInfo => ({
  pane_id: id, workspace_id: 'w0', tab_id: `t${id}`, cwd, ...rest,
});

test('AGENTS OUTVOTE SHELLS, which is the bug this was found as', () => {
  // Measured on the live board: a space labelled `e-avize-site` holding two
  // agents in e-avize, one agent and one forgotten shell in claude-harness.
  // Counting every pane made that 2–2, Herdr's listing order gave it to the
  // wrong repo, and the agent started there made it 3–2 for good.
  const panes = [
    paneAt('p1', '/repos/claude-harness'),
    paneAt('pH', '/repos/claude-harness', { agent: 'claude' }),
    paneAt('pN', '/repos/e-avize', { agent: 'claude' }),
    paneAt('pP', '/repos/e-avize', { agent: 'claude' }),
    paneAt('q1', '/repos/elsewhere', { workspace_id: 'wZ', agent: 'claude' }),
  ];
  assert.equal(seedCwd(panes, 'w0', new Map()), '/repos/e-avize');
});

test('shells are read only when the space has no agent at all', () => {
  const shells = [paneAt('p1', '/repos/a'), paneAt('p2', '/repos/a')];
  assert.equal(seedCwd(shells, 'w0', new Map()), '/repos/a');
  const withAgent = [...shells, paneAt('p3', '/repos/b', { agent: 'claude' })];
  assert.equal(seedCwd(withAgent, 'w0', new Map()), '/repos/b');
});

test('our own instruments never vote', () => {
  // The usage agent runs in ~/.harness, which is nobody's repo, and both it and
  // an aside are parked in a space that did not ask for them.
  const names = new Map([['p2', 'harness-usage'], ['p3', 'aside-w0-ph']]);
  const panes = [
    paneAt('p1', '/repos/a', { agent: 'claude' }),
    paneAt('p2', '/home/x/.harness', { agent: 'claude' }),
    paneAt('p3', '/repos/a', { agent: 'claude' }),
  ];
  assert.equal(seedCwd(panes, 'w0', names), '/repos/a');
  // With nothing but an instrument, the fallback must not reach it either.
  assert.equal(seedCwd([panes[1]], 'w0', names), null);
});

test('A TIE SEEDS NOTHING — listing order is not evidence', () => {
  const panes = [
    paneAt('p1', '/repos/a', { agent: 'claude' }),
    paneAt('p2', '/repos/b', { agent: 'claude' }),
  ];
  assert.equal(seedCwd(panes, 'w0', new Map()), null);
  assert.equal(seedCwd([...panes].reverse(), 'w0', new Map()), null);
});

test('a space with no panes of its own has no directory', () => {
  assert.equal(seedCwd([], 'w0', new Map()), null);
  assert.equal(seedCwd([paneAt('q1', '/repos/a', { workspace_id: 'wZ' })], 'w0', new Map()), null);
});

// -- dormant panes ---------------------------------------------------------
// A restore whose resume failed leaves a bare shell holding the session. The
// board used to drop every pane with no agent, so ten conversations vanished at
// once with nothing on screen saying they had — a dropped pane looks exactly
// like a pane that was never there.

const session = { value: 'u1', kind: 'id' as const, agent: 'claude' };

test('A FAILED RESTORE IS DORMANT, which is the shape the incident left', () => {
  assert.equal(dormantSession(paneAt('p1', '/repos/a', { agent_session: session }), 'agent-5'), 'u1');
});

test('a running agent and a plain shell are not dormant', () => {
  const running = paneAt('p1', '/repos/a', { agent: 'claude', agent_session: session });
  assert.equal(dormantSession(running, 'agent-5'), null);
  assert.equal(dormantSession(paneAt('p2', '/repos/a'), '1'), null);
  const byPath = paneAt('p3', '/repos/a', { agent_session: { ...session, kind: 'path' } });
  assert.equal(dormantSession(byPath, null), null);
  const other = paneAt('p4', '/repos/a', { agent_session: { ...session, agent: 'codex' } });
  assert.equal(dormantSession(other, null), null);
});

test('a dormant instrument stays off the board (invariant 18)', () => {
  // No agent means no Herdr name for `isInstrument`, so the tab label is all
  // that says this was a fork — whose transcript is the parent's changelist.
  const pane = paneAt('p1', '/repos/a', { agent_session: session });
  assert.equal(dormantSession(pane, 'aside'), null);
  assert.equal(dormantSession(pane, 'usage'), null);
});

test('a RECENT row is never resumable, whatever the file says', () => {
  const rows = parseRecent(JSON.stringify({ version: 1, rows: [{ paneId: 'w1:p1', name: 'a', dormant: true }] }));
  assert.equal(rows[0]?.dormant, false);
});

test('a resume carries the rules Herdr’s own resume drops', () => {
  const args = resumeArgs('u1', argsFor('rules', 'opus'));
  assert.deepEqual(args.slice(0, 2), ['--resume', 'u1']);
  assert.ok(args.includes('--append-system-prompt'));
  assert.ok(args.includes('--model'));
});
