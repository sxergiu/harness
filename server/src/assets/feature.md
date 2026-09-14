---
description: Plan, implement, review and file one feature as commit-sized changelists
argument-hint: <what to build>
---

Build this: $ARGUMENTS

Run the steps below in order. Never commit or push — the human owns all git
history. Keep your todo list current throughout; it is what the cockpit shows.

## 1. Scope

Grill the human before planning anything. Read enough of the code first that the
questions are about this codebase and not about software in general — a question
the code already answers wastes the human's turn.

Then ask with `AskUserQuestion`, up to four questions a round, as many rounds as
the answers open new ground. Ask only where different answers lead to materially
different work: what is in and out of scope, which reading of an ambiguous word
is meant, how a new thing behaves at its edges, which existing seam it should
extend. Put the option you would choose first and mark it `(Recommended)`. Do
not ask what has an obvious default, what the code already settles, or whether
the human approves of your plan — that is what step 2 is for.

Stop at ~95% understood: the point where every unknown left is one you would
resolve the same way whichever answer came back. Stop immediately if the human
says to get on with it. If nothing material is open, say so in one line and move
on — an unambiguous request earns no questions.

Close the step by stating the scope you settled on and the assumptions still
standing, and carry both into step 2.

## 2. Plan

Call the `planner` subagent with the request and the scope from step 1. Skip it only for a change that is
small and well understood, and say in one line that you skipped it and why — a
subagent costs its own context, so a one-line fix does not earn one.

Read the plan critically. Where it contradicts what you find in the code, the
code wins; say so rather than following it.

## 3. Implement

In this session, not in a subagent. A subagent's edits are recorded against its
own transcript, so they never appear in the changelist the human reviews.

## 4. Verify

Run the check this project documents — the build, typecheck or test command in
its CLAUDE.md or readme. Report what it actually printed. If the project
documents no check, say so; do not invent one, and do not claim the work is
verified.

## 5. Review

Spawn one subagent. Give it the list of files you changed and what you changed
in each — not a git diff: this working tree may hold other agents' work and
other pending workstreams. Prompt it with:

> You are reviewing one agent's uncommitted work. Below are the files it
> changed and the changes it made. Judge ONLY those changes.
>
> Anything that was already in the file is out of scope — however verbose,
> ugly or wrong it looks, it is not this changelist's, and a comment recording
> a hard-won invariant reads exactly like bloat to someone who was not there.
> Do not propose deleting or rewriting a line this agent did not write.
>
> Look for: a defect or a case the change does not handle; a place it
> introduced a new seam where an existing one would have served; a departure
> from the patterns already established in that file; leftover scaffolding,
> debug output or dead code; and comments that narrate the line below them,
> log the change ("was X, now Y"), or merely restate a name.
>
> Report each finding as file, line, what is wrong, and the smallest fix.
> Return the findings only — no summary of your process. If the work is sound,
> say so in one line.

## 6. Fix

Apply the findings you agree with, in this session. Say which you rejected and
why. Re-run the check from step 4 if you changed anything.

## 7. Version the new files

A changelist can only hold a file git tracks. An unversioned one sits in the
Unversioned Files node instead, so a `<change>` written for it is filed against
nothing and the work goes missing from its list without saying so — which is why
this happens here and not in the `changelist` agent, which never stages.

`git add` the files the feature created. Add, never commit: the human owns all
history, and `git add` writes none.

- **Add without asking** what the feature is actually made of — new components,
  classes, modules, templates, styles — and any file whose directory already
  holds tracked files of the same kind, which is how the project says it keeps
  them.
- **Add the notes and docs you wrote too**, but keep them out of the feature's
  groups: they go in one changelist of their own, carrying the `X ` prefix that
  marks a list not meant for commit, and reusing the project's existing notes
  list if it has one.
- **Never add** what git ignores, or scratch that merely happens to be in the
  tree: screenshots, scratchpad scripts, tool caches.
- **Ask** about what is left over — a standalone test script, a fixture whose
  fate is unclear. One `AskUserQuestion` listing them all, add against leave
  unversioned; never one question per file.

Report what you added and what you left alone.

## 8. File the work

Group what you changed into commit-sized slices — each one something that could
land as a single commit — and name each group in the dialect this project
already uses. Every file you added in step 7 belongs to exactly one group.

If the project defines a `changelist` agent, hand it the groups as
`name → files` and let it do the filing. Otherwise report the grouping and stop
there. Nothing is committed either way.

## Report

Close with: what you built, what the check printed, what the review found and
what you did about it, and the groups the work was filed under.
