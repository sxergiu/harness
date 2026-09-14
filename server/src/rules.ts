/**
 * What every agent the harness starts is told.
 *
 * This is the ENTIRE enforcement surface. There is no `canUseTool` here — an
 * agent in a Herdr pane is a real CLI process loading the user's own settings,
 * which permit Write, Edit and Bash without restriction. So these are
 * instructions, and an agent that ignores them does so silently: a hook that
 * denied edits until a plan existed was offered and declined in favour of a
 * smaller system. Do not describe any of this as enforced.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The human's own version of `RULES`, when they have written one. */
const OVERRIDE = join(homedir(), '.harness', 'rules.md');

const RULES = `You are running in a Herdr pane, supervised through a browser cockpit that
shows your status, your current work, and a diff of the files you change. These
rules apply to everything you do here.

1. NEVER commit or push. The human owns all git history, without exception.
   You may read git freely.

2. Keep your todo list current. The cockpit shows your in-progress item as the
   one-line summary of what you are doing, so a stale list misreports you.

3. Say what you are doing. Keep your work legible from a one-line summary —
   it is often all the human sees before deciding whether to look closer.

4. Plan before you implement, and delegate the planning when the work warrants
   it. For anything substantial or unfamiliar — several files, an unclear root
   cause, a real design choice — call the \`planner\` subagent yourself,
   autonomously, without asking permission. For a small, well-understood change,
   think it through and get on with it: a subagent runs its own context and is
   not free, so spending one on a one-line fix costs more than it saves.

5. Review against established patterns before proposing a change. Match the
   surrounding code's idioms, naming and structure rather than importing your
   own conventions.

6. Validate your assumptions. Probe the real system — read the actual file, run
   the actual command, inspect the actual data — rather than reasoning about
   what it probably does. Report what you found, including when it contradicts
   what you expected.

7. Trim to the minimal, cleanest change that satisfies the requirement. Prefer
   extending an existing seam to adding a new one. Delete what you replace.
   Comments must say what the code cannot — why it is this way, what breaks if
   it changes. Delete narration of the line below, change-log asides ("was X,
   now Y") and restatements of a name, and match the comment density of the
   file you are in.

8. Own the checkout you are working in. Several agents editing one tree collide,
   and the collision is only visible after the fact. If the work splits into
   separate features, do them in sequence yourself rather than expecting another
   agent to take one in parallel — you are the orchestrator for this checkout.
   Delegate investigation and planning; do not delegate the edits.

Your changelist in the cockpit is built from your own Write and Edit tool calls.
Two things are therefore invisible to the human reviewing your work: a file you
change with a shell command, and a file changed by a SUBAGENT, whose calls are
recorded against its own transcript and not yours. Keep edits in this session and
prefer the file tools when the choice is yours.

Each file you change appears in your changelist with your hunks only, so two
agents editing one file no longer claim each other's lines. If another agent
overwrites something you wrote, your hunk stays and is marked overwritten — so
leaving a mess is visible, not silent.`;

/**
 * Appended after RULES so it reads as an amendment to rule 1 rather than a
 * contradiction of it. Scope is the whole point: an agent that carries this
 * into another checkout has misread it.
 */
const GIT_DELEGATED_RULE = `Exception to rule 1, and only in this checkout: the human has delegated git
here. Stage, commit and push once the work you were asked to do is finished and
verified. Write the message in the style already in the log. Say what you
pushed, and remember that pushing this repository publishes it. Nothing here
extends to any other checkout.`;

/**
 * Every prompt below goes out as one line. Herdr refuses to start an agent
 * whose arguments contain a literal newline — "agent arguments cannot be
 * encoded safely for the target shell" — and fails the whole start rather than
 * dropping the flag. The numbering, or the paragraph, carries the structure.
 */
const flatten = (prompt: string): string => prompt.replace(/\s*\n\s*/g, ' ').trim();

/**
 * Native `claude` flags, passed through Herdr's `agent start -- <args>`.
 *
 * Rule 4's `planner` is not defined here. It lives in
 * `~/.claude/agents/planner.md`, so an agent started by hand in a terminal has
 * it too; passing the same prompt as `--agents` JSON gave it only to agents the
 * cockpit started. `harness init` is what puts that file there — see
 * `claudeFiles.ts`. If it is deleted, rule 4 names an agent that does not exist
 * — and, like everything else here, nothing reports it.
 *
 * Whether git is delegated is decided by the CALLER, against the checkout the
 * agent will run in (`projects.ts`). It is a required parameter rather than one
 * defaulting to `false`, because a default argument is how a fail-closed rule
 * quietly becomes something nobody reads at the call site.
 */
export function startArgs(gitDelegated: boolean): string[] {
  return ['--append-system-prompt', flatten(rulesFor(rulesText(), gitDelegated))];
}

/**
 * Split out pure so the fail-closed default can be pinned without a home
 * directory to read rules out of. Everything about the amendment is here: it
 * goes after the rules it amends, and it is absent entirely when git is not
 * delegated rather than being present and negated.
 */
export function rulesFor(base: string, gitDelegated: boolean): string {
  return gitDelegated ? `${base}\n\n${GIT_DELEGATED_RULE}` : base;
}

/** What ships, and what the settings screen offers to reset back to. */
export const DEFAULT_RULES = RULES;

/**
 * Read on every start rather than once at load, which is the whole contract the
 * settings screen states: an edit applies to agents started from now on. Cached,
 * it would apply to none of them until a restart.
 *
 * A file that is absent, unreadable or blank means the shipped rules — so
 * emptying the box is a reset, not a way to start agents with no rules at all.
 */
export function rulesText(): string {
  try {
    const text = readFileSync(OVERRIDE, 'utf8');
    return text.trim() === '' ? RULES : text;
  } catch {
    return RULES;
  }
}

/** Whether the agents are being told something other than what shipped. */
export function rulesAreDefault(): boolean {
  return rulesText() === RULES;
}

/**
 * Writing the shipped text back is a RESET, not a copy of it: leaving the file
 * behind would freeze today's defaults against every later version of them.
 */
export function setRules(text: string): void {
  if (text.trim() === '' || text === RULES) {
    try {
      unlinkSync(OVERRIDE);
    } catch { /* already gone, which is the state being asked for */ }
    return;
  }
  mkdirSync(dirname(OVERRIDE), { recursive: true });
  writeFileSync(OVERRIDE, text);
}

/**
 * What an ASIDE is told. Not `RULES`: those are about todo lists, changelists
 * and delegating a plan, and an aside does none of it — it answers one question
 * about a conversation it is a copy of.
 *
 * Same standing as everything else in this file: instructions. The aside is a
 * real CLI process in the parent's checkout with Write, Edit and Bash, and
 * nothing stops it editing. What the harness does instead is count what it
 * wrote and say so.
 */
const ASIDE = `You are a side conversation, forked from another agent's session. Everything
above is that agent's conversation, copied — you are a fork of it, it is still
running, and nothing you say reaches it. The human is reading its output in a
cockpit and has stepped aside to ask you about it.

Answer the question. Read whatever you need to answer it properly: the files,
the git history, the output of a command that only reads.

Change nothing. No Write, no Edit, no command that modifies anything. The agent
you were forked from is working in this same checkout, and a file you change
under it is a collision it will never see coming.

Do not carry on the work above. It is not yours. You are here to explain it.`;

/**
 * Forks the parent's session into a new one. `--fork-session` is what makes
 * this safe to run against a LIVE agent: verified on pane w2:pG, the parent's
 * transcript was byte-identical afterwards, so the main feed does not move.
 */
export function asideArgs(sessionUuid: string): string[] {
  return [
    '--resume', sessionUuid,
    '--fork-session',
    '--append-system-prompt', flatten(ASIDE),
  ];
}
