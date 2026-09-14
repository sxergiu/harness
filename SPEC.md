# Harness v2 — specification

**This is the design as written before the rewrite, kept for the reasoning behind each
decision rather than as an account of what runs today.** Everything in the future tense
here has since happened: the deletions below are done, and the appendix records the system
as it was probed at Herdr protocol 17. Where this and [CLAUDE.md](CLAUDE.md) disagree about
current behaviour, CLAUDE.md is the one maintained against the code.

A local-only browser cockpit for [Herdr](https://herdr.dev), the terminal multiplexer
that already runs the agents. **The harness stops running agents entirely.** It observes
Herdr and the agents' own transcripts, presents them better than a terminal can, and
sends a small set of commands back.

This replaces the gated 5-phase pipeline described in the old `CLAUDE.md`. That design is
deleted, not deprecated — see [What gets deleted](#what-gets-deleted).

---

## 1. Shape of the product

One page, two regions:

```
┌───────────────────────────────┬─────────────┐
│ SPACES                     +  │             │
│ ▾ web.app …/repos/web.app 2 ✎+│             │
│  ⬤ debug-uuid   web.app   12m │  agent view │
│    ▸ patch catalogue serializer             │
│    edit src/catalogue/mapper.ts             │
│  ○ run-onboarding web.app 18m │             │
│ ▸ harness  …/repos/harness 1! │             │
│ RECENT                        │             │
│  term-git                     │             │
└───────────────────────────────┴─────────────┘
```

- **Board** — one column of spaces, each collapsible, with its agents nested underneath and
  its directory on the header. Agents are sorted `blocked → done → working → idle →
  unknown` inside a space; grouping is the only thing that reorders them. A collapsed space
  shows an amber count of agents wanting attention, so a fold can never hide one. `RECENT`
  closes the column with the agents whose panes are gone.
- **Agent view** — opened from a row, with two tabs: `feed` and `diff`.

Visual direction: **dense, terminal-adjacent.** Dark, monospace, tight rows, minimal
chrome. It should sit naturally beside Herdr and fit as many agents on screen as possible.

Access: **`127.0.0.1` only, no auth.** No phone, no LAN, no remote Herdr. This keeps the
old harness's simplest invariant intact.

---

## 2. Architecture

```
Herdr server ──unix socket──┐
 (topology, status,          │
  raw pane text)             ▼
                        harness server ──WebSocket──▶ browser
 ~/.claude/projects/    (Fastify, 127.0.0.1)          (React)
  <slug>/<uuid>.jsonl ──┘
 (messages, tools, todos)
```

Two sources, each authoritative for different things. Never guess which one to ask.

| Question | Source |
|---|---|
| What agents exist, where are they, what's their status | Herdr socket |
| Workspace / tab / pane topology, cwd, terminal title | Herdr socket |
| Raw terminal text (blocked prompts only) | Herdr `pane.read` |
| What the agent said, which tools it called, its todos | JSONL transcript |
| What files it changed | JSONL transcript |

### The join

Herdr reports `agent_session.value` — for Claude that is the session UUID. The transcript
is at:

```
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

where `<cwd-slug>` is the absolute cwd with every `/` and `.` replaced by `-`
(`/Users/x/repos/web.app` → `-Users-x-repos-web-app`; a leading `/.` yields `--`).

This mapping is **inferred, not documented.** Treat a missing transcript as a normal
state — the agent still appears on the board with status only.

The session UUID changes when the user runs `/clear` or resumes a different session. The
server must re-resolve the transcript path on every `pane_updated` event, not cache it for
the life of the pane.

### Liveness

The server opens one socket connection and calls `events.subscribe`. Relevant events:
`pane_agent_detected`, `pane_agent_status_changed`, `pane_output_changed`, `pane_exited`,
`pane_created`/`closed`/`updated`, and the workspace/tab lifecycle.

Transcripts are tailed by byte offset — the server holds a read position per agent and
pushes only new entries.

**On disconnect:** show a banner, dim the board to last known state, retry silently, and
do a full resync (`session.snapshot`) on reconnect. `RECENT` stays readable throughout
because it comes from disk, not from Herdr.

**Check the protocol version on connect.** Herdr is at protocol 17; refuse to run with a
clear error rather than misinterpret an unknown version.

---

## 3. The board

Each row:

```
⬤ debug-uuid          web.app        12m
  ▸ patch catalogue serializer          ← current todo (when present)
  edit src/catalogue/mapper.ts          ← activity line (always)
```

| Field | Derivation |
|---|---|
| Status dot | Herdr `agent_status` |
| Name | Herdr agent name — see [Agent rules](#6-agent-rules) |
| Repo | basename of Herdr `cwd` |
| Elapsed | **time in current state**, not session age |
| Activity line | newest `tool_use` in the transcript, humanised |
| Todo line | the `in_progress` item from the latest `TodoWrite` |
| Question preview | for blocked agents only — see below |

**Elapsed needs a server-side clock.** Herdr exposes `state_change_seq`, a counter, not a
timestamp. The server stamps the time whenever it receives `pane_agent_status_changed`
and keeps it in memory. After a harness restart it is unknown until the next transition;
fall back to the newest transcript timestamp rather than showing a wrong number.

**No cost display anywhere.** Explicitly cut.

**Collisions.** The server maintains `path → {agents}` across live agents sharing a repo.
When two agents have both written a file, both diffs mark it and the board shows
`⚠ 2 agents contending in web.app`. This is a warning only — agents share one checkout
and nothing is locked. Worktree isolation was considered and rejected.

---

## 4. The agent view

### `feed` tab — structured only

Rendered from the transcript. **Not a terminal mirror.** There is no raw toggle.

- Assistant prose renders as markdown.
- Every tool call is **one line**: name, primary argument, result badge.
- Clicking a line expands the full input and output.

```
▸ Read   src/catalogue/mapper.ts
▸ Edit   src/catalogue/mapper.ts  +3 −1
▾ Bash   npm test -- catalogue   ✓
   │ Tests: 12 passed, 12 total
▸ Read   src/catalogue/types.ts
```

**Subagent calls nest.** Because agents are required to delegate (see
[Agent rules](#6-agent-rules)), this is the normal shape of a feed, not an edge case.

```
▸ Read   server/src/runs/diff.ts
▾ Agent  Explore · 85s · 10 tools        ← collapsed line needs no file read
   │ ▸ Bash  grep -rl claude-agent-sdk
   │ ▸ Read  server/src/runs/diff.ts
   │ └ returned import graph
▸ Edit   server/src/runs/diff.ts  +3 −1
```

- The parent records the delegation as a `tool_use` named **`Agent`** (not `Task`), with
  input `{subagent_type, description, prompt, run_in_background}`.
- The subagent's own transcript is at
  `~/.claude/projects/<slug>/<parent-session-uuid>/subagents/agent-<agentId>.jsonl`,
  with `isSidechain: true` and the parent's `sessionId`.
- **Join key:** the parent's `toolUseResult.agentId` is exactly the `<agentId>` in that
  filename. No heuristics, no timestamp matching.
- The parent's `toolUseResult` also carries `agentType`, `totalDurationMs`, `totalTokens`
  and `toolStats` (`readCount`, `bashCount`, `editFileCount`, `linesAdded`/`Removed`), so
  the **collapsed line renders without opening the subagent file at all.** Only expansion
  reads it.

Subagent transcripts are substantial — 148 KB for one modest Explore call — which is
precisely why the collapsed line must be served from the parent's metrics.

**Pagination is by turn.** A turn runs from one user message to the next. The view opens
on the latest turn; scrolling up loads the previous turn whole. Never chunk by bytes —
transcripts already reach 1 MB and a turn is the unit the work is actually shaped in.

**The one exception to "structured only": blocked agents.** The browser does not parse
permission prompts. It shows Herdr's verbatim pane text plus generic key buttons.

### `diff` tab

Built from `Edit` / `Write` / `NotebookEdit` inputs in this agent's transcript — **never
from git.** The harness does not execute git at all.

```
[ feed | diff ·3 ]
 M mapper.ts        +3 −1
 ⚠ types.ts         +1 −0   also written by 'onboarding'
 A mapper.test.ts   +24
```

Read-only. No revert, no stage, no commit — the human owns all git operations.

> **Known blind spot, accepted deliberately.** A file written by a Bash command
> (`sed -i`, `npm install`, a codegen script) produces no tool call and is therefore
> **invisible** in this view. The old harness detected these by diffing against git and
> flagging `unrecordedChanges`; removing git removes that detector too. Per-agent diffs
> are perfectly attributed and knowingly incomplete.

---

## 5. Actions

| Action | Herdr call | Notes |
|---|---|---|
| Prompt an idle agent | `agent.prompt` | Structured, no keystroke guessing |
| Interrupt | `agent.send_keys` esc | Unambiguous |
| Unblock | `agent.send_keys` | Buttons always live — see below |
| Start an agent | `tab.create` + `agent.start` | One click on a space; no form |
| Rename an agent | `agent.rename` | Inline on the row |
| Rename a space | `workspace.rename` | Inline, beside its directory |
| Manage spaces/tabs | `workspace.*`, `tab.*` | Close requires confirm — it kills live agents |
| Jump to terminal | `agent.focus` | Focuses the real pane; the escape hatch |

**Unblocking is optimistic by design.** Buttons are always enabled. The browser sends the
keystroke, re-reads the pane, and shows what actually happened. It never refuses on
uncertainty. The accepted risk: a mistimed keystroke can land in the agent's prompt box as
literal text or dismiss the wrong dialog. Nothing is hidden — the raw pane text is on
screen the whole time.

**Starting an agent asks nothing.** `agent.start` takes no cwd, so a directory still has to
be decided before the agent exists — but it is decided once, on the **space**, not on every
start. `+` on a space creates a tab there in that directory and starts `claude` in it; the
name is derived from the space and renamed inline afterwards if it matters.

The space directory is read off the panes the space already has, overridable by hand, and
held **in memory only**. A workspace id means nothing outside one Herdr session and Herdr
reuses ids, so persisting the pair could start an agent in the wrong repo — the same reason
`stateSince` is legitimately unknown after a restart.

---

## 6. Agent rules

These are instructions, not enforcement. **There is no `canUseTool` anymore** — agents are
real CLI processes started by Herdr, loading the user's own `~/.claude/settings.json`
(which contains `Write(*)`, `Bash(*)`, `Edit(*)`). Scope enforcement is gone, not
weakened. The README must say so plainly.

Injected into every agent the harness starts:

1. **Never commit or push.** The human owns all git history.
2. **Keep your todo list current.**
3. **Say what you're doing** — set a short, accurate terminal title early.
4. **Plan before implementing, via subagents.** Delegate autonomously — do not ask
   permission to use one.
5. **Review against established codebase patterns** before proposing a change.
6. **Validate assumptions** by probing the real system rather than reasoning about it.
7. **Trim to the minimal, cleanest change** that satisfies the requirement.

### The planner/implementer rule

Every unit of work runs plan → implement, with planning delegated to a subagent:

```
agent
 ├ Agent(planner)      reads the codebase, reports existing patterns,
 │                     states assumptions and how each was validated,
 │                     proposes the smallest coherent change
 └ implements          against that plan, in the main session
```

The planner is read-only. The implementer works in the main session because that is where
the human can interrupt it.

**Enforcement surface.** Herdr's `agent start … -- <agent-args>` passes native flags
through to the `claude` CLI. Verified available: `--append-system-prompt`, `--agents`,
`--settings`, `--permission-mode`. So the harness launches agents as:

```
herdr agent start <name> --kind claude --pane <id> -- \
  --append-system-prompt <rules 1-8>
```

The planner was passed as `--agents '{"planner": {...}}'` until it moved to
`~/.claude/agents/planner.md`, where the CLI loads it for hand-started agents too. One
definition, and one flag left on the launch line.

**Injection is the whole mechanism. Decided: instruction only.** No hook, no detection, no
violation badge in the UI.

> Stated as "must be enforced", implemented as instruction. Be honest about the gap: with
> `canUseTool` gone, the only mechanism with real force would be a `PreToolUse` hook
> passed via `--settings` denying `Edit`/`Write` until an `Agent` call has occurred. That
> was offered and declined, along with the zero-machinery alternative of flagging
> violations in the board from transcript data. So an agent that ignores rules 4–7 does so
> silently and nothing reports it. Accepted deliberately in favour of a smaller system.

**Names are required.** Agents started from the browser get a name at launch. Agents
started by hand are auto-assigned a slug derived from their terminal title on first sight,
matching Herdr's `[a-z][a-z0-9_-]{0,31}` and unique among live agents.

> This mutates the user's environment: the harness renames agents it did not start.
> Chosen deliberately over long, drifting terminal titles as row identifiers.

**The UI never depends on rule 2.** A row with no todo shows only its activity line. Todos
are best-effort; the instruction improves the odds, and graceful degradation covers the
rest.

---

## 7. Notifications

Fire on **blocked**, **finished** (Herdr's `done` — idle after unseen work), and **died**
(`pane_exited`). Each fires an OS notification *and* a Herdr toast (`notification.show`).

No suppression when the agent's view is already open — deliberately not chosen.

The browser tab title and favicon show the count of agents needing attention, so a
background tab still tells you.

---

## 8. History

Closed agents drop from the board into `RECENT` and stay readable — full structured feed
and diff. Only the mapping needs storing:

```
agent name · session uuid · transcript path · cwd · workspace · first seen · last seen
```

One SQLite table via the existing `better-sqlite3` dependency. It is a cache, not a source
of truth: deleting it loses only the name/workspace association.

> **Transcripts are not permanent.** Claude Code prunes them — there is a `.last-cleanup`
> marker and `cleanupPeriodDays` is unset here, so the default retention applies. The
> transcript count on this machine fell from 163 to 140 *during a single working session*.
>
> `RECENT` must therefore treat a missing transcript as a **normal state**, not an error:
> the row stays, the feed and diff render as "transcript no longer on disk". Do not build
> anything that assumes a durable archive, and do not copy transcripts to create one
> unless that is asked for explicitly.

---

## What gets deleted

Gut in place — same repo, same directory. Nothing here is committed yet.

**Deleted** (~80% of 5,454 lines): `runs/engine.ts`, `runs/policy.ts`, `runs/questions.ts`,
`runs/journal.ts`, `runs/spawn.ts`, `runs/launcher.ts`, `runs/supervisor.ts`,
`runs/registry.ts`, `runs/scope-resolve.ts`, `runs/scope.ts`, `phases.ts`, `roles.ts`,
`prompts.ts`, `projects.ts`, `git.ts`, `fixture.ts`, `ScopeConfirm.tsx`, `Trace.tsx`,
`NewFeature.tsx`, `ProjectSettings.tsx`, the `check:git-guard` script, and the
`@anthropic-ai/claude-agent-sdk` dependency.

Every SDK invariant in the old `CLAUDE.md` goes with them — `settingSources: []`,
the `allowedTools` shadowing rule, the interactive-phase rule, `canUseTool` question
answering, `rewindFiles`, the git `PreToolUse` hook. Each existed only to constrain agents
the harness itself spawned. **They are not lessons to carry forward; they are answers to a
question this product no longer asks.**

**Survives:** `Diff.tsx`, `runs/diff.ts`, `runs/journal.ts`, `Markdown.tsx`, the
`useHarness.ts` WebSocket client pattern, and the `osascript` half of `notify.ts`.

Verified import-graph facts that constrain the gutting:

- **`diff.ts` imports `gitDirtyPaths` from `git.ts`** — it is the only importer. So
  "delete `git.ts`, keep `diff.ts` unchanged" is not possible. `diff.ts` must first drop
  its `otherDirtyPaths` / `unrecordedChanges` / `gitAvailable` outputs; `git.ts` then goes.
  Its other three exports (`assertReadOnlyGitArgs`, `isRepo`, `currentBranch`) already have
  no importer.
- **`diff.ts` has no SDK dependency** and no phase/run-machinery dependency. It reads the
  journal structurally. Its only internal dep is `runs/journal.ts`, which is self-contained
  (node builtins only) — hence journal.ts joining the keeper list.
- **`Diff.tsx`'s transitive closure is clean** — react, highlight.js, shared diff types,
  and `useHarness`. Its only coupling to the server is the HTTP shape of the diff endpoint.
- **`ServerEvent` dies with the pipeline.** Every one of its nine variants embeds a
  pipeline type. Only `ClientEvent`, the three constants (`WS_PATH`, `DEFAULT_PORT`,
  `BIND_HOST`) and the diff types (`DiffLine`/`DiffHunk`/`DiffFile`/`RunDiff`) are
  genuinely independent and carry over.
- The SDK is imported by exactly three files, all of them already on the deletion list.

---

## Open questions

None. The last one — what the placement picker looks like, given it appeared on every
start — was answered by removing it: the directory moved to the space, so nothing is asked.
Splitting a pane went with it; a started agent always gets its own tab.

## Deferred

- **Non-Claude agent kinds.** They appear on the board with status only; the structured
  feed is Claude-specific. Nothing renders in their detail view.
- **Keyboard navigation** — not chosen.
- **Notification suppression while watching** — not chosen.

## Risks

| Risk | Standing |
|---|---|
| Keystroke unblocking is racy | Accepted explicitly |
| Bash-written files invisible in diffs | Accepted; no detector replaces `unrecordedChanges` |
| Harness renames agents it didn't start | Accepted |
| Transcript path rule is inferred | Degrade to status-only when unresolvable |
| Transcripts are pruned on a retention timer | `RECENT` treats a missing file as normal |
| Subagent transcripts are large (148 KB each) | Collapsed line uses parent metrics only |
| Session UUID changes on `/clear` | Re-resolve on every `pane_updated` |
| Herdr protocol may change | Version-check on connect, fail loudly — since replaced by a floor with no ceiling, so a newer Herdr simply runs |
| No auth | Bind `127.0.0.1` only — unchanged from v1 |

---

## Appendix — verified facts

Established by probing the live system, not assumed:

- Herdr socket API: **protocol 17**, 89 request methods, `events.subscribe`, 25 push event
  types including `pane_output_changed` and `pane_agent_status_changed`.
- `agent.list` returns `agent_session.value` = the Claude session UUID. Confirmed against
  disk for two live agents.
- `AskUserQuestion` appears in the transcript as a `tool_use` with full question and option
  text — so a blocked agent's question is structurally knowable.
- A `tool_use` with no matching `tool_result` reliably identifies a pending call.
- The subagent tool is named **`Agent`**, not `Task`. **8 of 140** transcripts contain one.
  (An earlier draft of this spec claimed "zero `Task` calls in 163 transcripts" and
  deferred nesting on that basis. The grep was for a tool name that does not exist; the
  count was also taken before a cleanup pass. Both figures were wrong.)
- Subagent transcripts live at `projects/<slug>/<parent-uuid>/subagents/agent-<id>.jsonl`,
  `isSidechain: true`, joined to the parent by `toolUseResult.agentId`. Observed: 31
  entries / 148 KB for one Explore call.
- The parent's `toolUseResult` carries `agentType`, `totalDurationMs`, `totalTokens`,
  `toolStats` — enough to render a collapsed subagent line with no extra file read.
- Transcripts are pruned: a `.last-cleanup` marker exists, `cleanupPeriodDays` is unset,
  and the count fell **163 → 140 within one session**.
- `claude` CLI accepts `--append-system-prompt`, `--agents`, `--settings`,
  `--permission-mode` — the enforcement surface for injected rules.
- Largest observed transcript: **1 MB** (`web.app`, single session).
- All five live agents are named `claude`; their terminal titles carry the real subject.
- Claude Code also keeps `~/.claude/file-history/<session>/…` — a per-session file version
  store. Not used by this spec; noted as a possible future diff source.
