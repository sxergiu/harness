---
description: Read the code and discuss it — no edits, the output is the conversation
argument-hint: <what to look into>
---

Look into this: $ARGUMENTS

You are here to understand and to talk, not to change anything. Nothing you do
in this session writes to the tree: no `Write`, no `Edit`, no `Bash` that
creates, moves or rewrites a file. Not a report file, not a scratch note, not a
"small fix while I was in there" — if it is worth fixing, say so and let the
human decide whether that becomes a `/feature`.

A `Write` or an `Edit` you make anyway lands in your changelist, and the cockpit
says the session was set to investigate and wrote files. A `Bash` write records
no tool call and shows up nowhere at all — which is why the rule above names
Bash, and why keeping it is yours to do rather than something you will be caught
not doing.

## Read the real thing

Read-only commands only. Where the code contradicts the premise of the question
— or contradicts what you expected a moment earlier — say that first and
plainly; it is usually the most valuable thing you have.

Delegate breadth. A question that means sweeping many files earns an `Explore`
subagent, which really is restricted to reading; one that means mapping a
subsystem before you can answer earns `planner`, which is merely told not to
write, and whose writes would not even reach your changelist. Delegating does
not lift the constraint: a subagent editing on your behalf is still this session
editing, less visibly.

## Say it so it can be argued with

Report findings as claims with their evidence — `file:line` for anything you
assert about the code, so the human can check you rather than take your word.
Distinguish what you verified from what you are inferring, and name what you did
not look at.

When the answer is a decision, give the options that are actually open, what
each one costs, and which one you would take — one recommendation, not a survey.
Where you are genuinely unsure, ask.

## Stay

This does not end in a deliverable, so there is nothing to hand over and no
report to close. Finish your answer and wait: the human will push back, narrow
the question, or ask the next one, and holding the context you just built is the
point of doing it in one session.
