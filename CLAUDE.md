# CLAUDE.md — orientation for an agent with no prior context

Read this first, then [SPEC.md](SPEC.md) for the full design and the reasoning behind
every product decision. [README.md](README.md) states what this does and does not
guarantee; [USAGE.md](USAGE.md) is how a human runs it.

## What this is

A **local-only browser cockpit over [Herdr](https://herdr.dev)**, the terminal
multiplexer that runs the coding agents. One human, one machine, `127.0.0.1`, no auth.

**The harness does not run agents.** Herdr does. This process observes and presents:

```
Herdr socket ──┐
 (topology,     ├─▶ board.ts ──▶ Fastify + WS ──▶ React (via Vite proxy)
  status)       │    the join
~/.claude/…  ───┘
 (messages, tools, todos, diffs)
```

Herdr owns identity and status. The agents' own JSONL transcripts own content. `board.ts`
joins them on `agent_session.value` → `~/.claude/projects/<cwd-slug>/<uuid>.jsonl`.

This replaced a gated 5-phase pipeline. That design and every SDK invariant it needed are
**deleted, not deprecated** — they constrained agents the harness itself spawned, and it
no longer spawns any. Do not resurrect them.

## Invariants that must never be broken

Every one was established by probing the live system, and most fail *silently* if reverted.

1. **A Herdr request connection is one-shot.** Connect, send one request, read one
   response, the server closes. A second write returns `EPIPE`. Every request therefore
   opens its own connection. This cost a long debugging session; do not "optimise" it into
   a pooled or persistent connection.
2. **`events.subscribe` is the sole exception** — that connection stays open and streams
   pushes, and nothing else is ever written to it. **Only the NEWEST subscriber is fed.**
   Measured: subscription A took 9 pushes in 5s, then exactly 0 over the next 8s from the
   instant B subscribed, while B took 9 — and A never recovers, not even once B
   disconnects. The socket stays open, stays `connected`, and silently delivers nothing
   forever. So any other subscriber — an agent probing the socket, the Herdr CLI, a second
   cockpit — permanently kills the cockpit's event feed, and nothing observable says so.
   This is why liveness may never depend on holding the stream (see 6), and why
   `POST /api/refresh` reclaims it rather than merely resyncing.
3. **Subscriptions are dot-named (`pane.updated`); pushes arrive underscore-named
   (`pane_updated`).** Subscribing with the push spelling is accepted and delivers nothing.
4. **Decode socket chunks with `StringDecoder`.** Pane titles contain multi-byte glyphs and
   an 8 KB snapshot splits across chunks; `chunk.toString()` corrupts the JSON at the seam.
5. **`pane.updated` carries `agent_status` AND `agent_session`.** One global subscription
   covers both status changes and session re-resolution. `pane.agent_status_changed`
   requires a `pane_id` and cannot be subscribed globally — don't reach for it.
6. **Any push triggers a debounced full resync** from `session.snapshot`, **and so does a
   3s heartbeat.** The board never maintains incremental state from push payloads. One code
   path that always yields the whole truth beats a dozen that each yield part of it — and
   because that path is also on a timer, losing the stream to a newer subscriber (2) costs
   freshness rather than correctness. Do not remove the heartbeat to "save a snapshot":
   without it the board freezes on whatever it last knew, which is exactly what agents
   stuck in a state they left minutes ago looked like.
7. **`stateSince` is our clock.** Herdr exposes `state_change_seq`, a bare counter with no
   timestamp. Elapsed time is stamped by us on observed transitions and is legitimately
   unknown after a restart.
8. **The session uuid changes on `/clear`.** Re-resolve the transcript path on every
   resync; never cache it against a pane.
9. **Transcripts are pruned on a retention timer.** A missing transcript is a normal state,
   never an error. The count fell 163 → 140 during a single working session.
10. **A diff is a per-agent CHANGELIST, built from that agent's own recorded
    `structuredPatch` hunks — never from git, and never by diffing against the file on
    disk.** Disk-diffing is the trap: it attributes every other agent's work to whoever
    created the file. Measured before the fix, one agent claimed `create +349 −0` on a
    349-line file while another claimed `+105 −14` of the same lines — the same additions
    in two changelists at once. One file touched by two features must appear in both
    changelists holding only its own hunks. Note the spelling: transcripts use
    `toolUseResult` (camelCase); the deleted pipeline used `tool_use_result`.
    Consequences, all deliberate: hunks describe what the agent **did**, not what the file
    looks like now; a hunk since overwritten is still shown, flagged `stale`, because
    dropping it would hide that the work was clobbered; and line numbers are as-of-that-edit
    and are never recomputed, so treat them as provenance rather than coordinates.
    Staleness is a substring test over *contiguous runs* of added lines — testing a whole
    hunk as one block never matches and flags nearly everything, and the whole-file hunk of
    a `create` is exempt for the same reason.
11. **Herdr refuses agent arguments containing a literal newline** — "agent arguments cannot
    be encoded safely for the target shell" — and fails the whole `agent.start`, it does not
    drop the flag. `rules.ts` therefore flattens its system prompt to one line, which is
    now the only argument it passes.
12. **A new pane is not ready when `tab.create` returns.** The shell is still sourcing rc
    files for ~0.5s, and `agent.start` starts an agent by *typing* the command — so a start
    issued immediately is swallowed, leaving a mangled line at a prompt while `agent.start`
    still answers `ok`. Wait with `pane.wait_for_output` (Herdr's CLI documents `--pane` as
    "existing pane at an interactive shell prompt" for this reason). Best-effort: an
    unrecognised prompt must not make starting impossible.
13. **`agent.start` returns before the agent is usable**, with `launch_pending: true`. For
    ~3.2s Herdr then refuses `agent.prompt` ("not an active named agent") and `agent.rename`
    ("startup is pending") — while the agent is visibly running, so this reads as a dead
    cockpit rather than an error. There is no push and no blocking form: poll `agent.get`,
    which is exactly what `herdr agent start` does. `timeout_ms` does not change it.
14. **`agent.prompt` does not reliably submit.** Observed once: the text was typed into
    Claude Code's prompt box and left there unsent, and the *next* Enter sent it a turn
    late. It is not our request — relaying Herdr's socket shows its own CLI sends the
    identical frame, and no submit flag exists. `herdr.prompt()` therefore reads the pane
    afterwards and presses Enter only if the box **still holds anything at all** — the check
    is deliberately CONTENT-FREE, and comparing it against the text we sent is the one thing
    it must never go back to. Claude Code collapses a paste into
    `[Pasted text #1 +61 lines]`, which contains none of that text, so the old head-match
    went blind exactly where it was needed most: a stalled paste read as submitted and sat
    in the box until the human sent a second prompt, whose Enter submitted the paste a turn
    late. That was the "pasting needs sending twice" bug. Measured: a 62-line paste typed
    into a live box rendered that placeholder and the head-match saw nothing, while an
    emptiness test saw it; one Enter then submitted it (`state_change_seq` 2187 → 2190, box
    emptied). Match the **last `❯` line only**: a submitted prompt is echoed into the
    scrollback as `❯ <text>`, so testing every `❯` line calls a successful prompt unsent and
    earns it a spurious Enter. Emptiness is the one signal true in EVERY case — submitted and
    queued-while-working both leave the box empty, verified live with echoes in the scrollback
    above it — and it holds regardless of size: the placeholder is on screen within 160ms, a
    42 KB paste within 80ms, so the 500ms window stands.
    The stall is **not paste-specific and not rare**: it reproduced on plain single-line text,
    and Herdr will name it itself — `agent.prompt` takes `wait: {until, timeout_ms}` and
    answers `agent_prompt_stalled` ("no observed state change within 5000 ms; status is done
    and state_change_seq remained 2187"). That detector is not used, because it only observes
    state CHANGES: from a settled agent it is fast (119–439ms) and authoritative, but a prompt
    queued at a WORKING agent produces no change, so it burns the whole timeout and returns
    `timeout` (measured 6193ms) for a prompt that in fact arrived. One pane read answers both.
    The nudge must stay a verified one and never become an unconditional keystroke.
    **A slash command reproduces it every time**, and the pane must be read WHOLE to see
    it: the command menu opens beneath the box and is tens of rows tall, so the last 14
    visible lines are all menu and hold no `❯` line at all — which the check read as
    "submitted" and let `/exit` sit in the box until the human pressed exit a second time,
    that Enter sending the first one. Measured on a live agent: `lines: 14` found zero `❯`
    lines, the whole visible region found exactly `❯ /exit`, and one Enter then ended the
    agent. Omit `lines` rather than raising it — the menu grows with the viewport. The
    menu itself is safe to read over: it marks its selection by highlight, not by `❯`,
    and Enter submits the box rather than the highlighted row.
15. **A LOCKFILE is the single-instance mutex, checked before the bind.** Binding the port
    used to be it, which held only while the port was fixed. It is not: `--port` exists so a
    machine already using 4373 is not locked out, and two instances on two ports means the
    newer one permanently starves the older of Herdr's event stream (invariant 2) with both
    windows still open. `instance.ts` writes `~/.harness/harness.lock`, and a second start
    OPENS the running cockpit rather than erroring — what someone typing the command twice
    wants. The lockfile says where to look and `GET /api/health` decides whether anything is
    there: trusting the recorded pid would inherit pid reuse, where an unrelated process on a
    dead harness's pid makes the cockpit refuse to start over an instance that does not
    exist. So a lock whose port does not answer is stale, not a refusal. Consequently
    `EADDRINUSE` now means **something that is not a harness** — the probe already ruled that
    out — and the message says so; the old one blamed a second instance and sent people
    hunting for it. Writing the lock is best-effort: an unwritable home costs the mutex and
    warns, never the ability to start.
    **"Opens the running cockpit" is a decision, not a URL.** Opening its port unconditionally
    was wrong twice over, and both showed up as browser tabs nobody wanted. A DEV instance
    serves no page — Vite does, on `DEV_PAGE_PORT`, and this port answers `GET /` with
    `{"message":"Route GET:/ not found"}` — so every invocation left one more JSON 404 open;
    and `open`/`xdg-open` give you a NEW tab rather than the one you already have, so even a
    correct URL piled up. `GET /api/health` therefore carries `page` (does THIS process serve
    the cockpit) and `viewers` (sockets connected right now, however they were served —
    measured at 16 on a working session), and `pageOf` resolves the page: its own origin when
    built, Vite's when not and something answers there, null when there is nothing to open.
    A cockpit somebody is already looking at gets a line of text instead of a duplicate,
    which also covers dev, where the viewer is connected through Vite's proxy to this same
    socket. Health defaults every field on the way in — it is an unauthenticated local port,
    and an older harness answers the same probe without the newer two fields.
    **`viewers` ALONE IS NOT THE GUARD, and believing it was is how the tabs came back a
    third time.** The count legitimately reads 0 for the second after any restart, while the
    cockpit's sockets are dropped and have not yet retried — and `npm run dev` respawns the
    server into this check on every save. Measured: ONE touch of a server file put seven tabs
    in the browser; a session of ordinary editing left **90**. Re-probing does not fix it
    either, because the browser's own retry is 1000ms, so any wait short enough to keep the
    command fast is a coin flip against it. The decision is `shouldOpen` in `instance.ts` and
    it is deliberately conservative: **a DEV instance is never opened automatically at all.**
    Its page is Vite's, which the human opened themselves and still has, so there is nothing
    to restore and the URL on stdout is the whole of what they need; only a built instance —
    one that serves its own page, and which no watcher is respawning — is ever opened, and
    then only at zero viewers. `--no-open` on both of `server`'s scripts is a second line of
    defence and not the fix; it was on `dev` but NOT on `start` for the whole time this was
    believed solved, and `start` is what was running. Three tests pin the three cases, because
    every previous version of this guard also looked correct in the file it was written in.
    **Unbuilt, `/` serves an explanation rather than that 404**, so the tabs already open
    say what happened when they are reloaded. Only `/`: every other unmatched path keeps the
    JSON 404, which is the right answer for the API this is.
16. **Bind `127.0.0.1` only.** There is no auth.
    **4317/4318 were the OpenTelemetry OTLP ports** — gRPC and HTTP — and Jaeger, Alloy and
    SigNoz all bind them too. Invisible on a machine running no collector, an instant
    collision on one that is, so it could only ever break on someone else's machine. Now
    4373 and 4374.
    **The bind is NOT on its own enough, and `origin.ts` is the rest of it.** Two holes it
    closes, neither visible from the bind: DNS REBINDING makes a hostile page's requests
    arrive looking local, and only the `Host` header still carries the attacker's name — so
    every request is checked, not just the upgrade. And WEBSOCKETS ARE NOT SUBJECT TO CORS,
    so any page open in the browser could `new WebSocket('ws://127.0.0.1:4373/ws')` and read
    the whole board — names, cwds, todo text — which the server volunteers on connect. That
    was pure exfiltration at zero cost to the attacker, and it is why the check is repeated
    inside the `upgrade` handler: the `onRequest` hook never runs for an upgrade.
    The PORT is deliberately not part of the test — in development the page is on Vite's
    port and proxied here, so pinning it would break `npm run dev` and teach the next person
    to delete the check. A MISSING `Origin` is allowed, because curl, the probe scripts and
    every non-browser client send none while browsers always do. And the test is on the
    parsed HOSTNAME, never a substring: `http://127.0.0.1.evil.com` contains `127.0.0.1` and
    is a different machine.
17. **`blocked` is a guess Herdr makes from the screen, and it misses prompts.** Detection
    is a TOML manifest of regex rules per agent kind, auto-updated from Herdr's servers into
    `~/.local/state/herdr/agent-detection/remote/claude.toml`; `herdr agent explain <pane>
    --verbose` shows every rule, the text region it read and why it did or did not fire.
    Whatever no rule matches falls through to `default_known_agent_idle_fallback` — **idle**,
    indistinguishable from a finished turn. Measured: with the Claude in Chrome
    site-permission dialog on screen (`Claude in Chrome wants to navigate on …` / `1. Allow`
    / `2. Allow all actions on … for this session` / `3. Deny (esc)`) the pane reported
    `idle`, then `done`, and the cockpit — which gates its blocked panel on
    `status === 'blocked'` — never showed the panel. The dialog shares no phrase with any
    existing rule: no `do you want to proceed?`, no `esc to cancel`, no enter hint. Fixed
    by a local override at `~/.config/herdr/agent-detection/claude.toml` adding rule
    `chrome_extension_permission_prompt` over region `after_last_horizontal_rule` (the live
    region, so it clears itself when the dialog is answered — `whole_recent` would keep
    matching the scrollback and pin the agent blocked forever). A local file **shadows the
    remote manifest entirely** rather than merging, so Herdr's own detection updates stop
    arriving until the copy is refreshed; a malformed override is ignored with a warning and
    the remote one stays. The panel itself needed no change — its `1`/`2`/`3` buttons
    already map onto Allow / Allow-all / Deny. Expect other prompt shapes to be invisible
    the same way: when an agent reads idle but is not, run `agent explain` before suspecting
    the cockpit.
    **`herdrRules.ts` MERGES rather than shipping a copy, and that is the whole design.**
    Shipping a frozen manifest is wrong the day after it is written: measured here, a
    hand-made override sat at `2026.08.29.1` while the remote had reached `2026.09.11.1`,
    silently holding back an upstream fix to the Bash approval prompt. So `harness init`
    reads the user's CURRENT remote and appends our one rule to it — safe without a TOML
    parser, because a trailing `[[rules]]` opens a fresh array-of-tables entry and cannot
    absorb the table above it, and because Herdr resolves by `priority` rather than by file
    order (the remote's own priorities run 1100, 970, 965, 975, 1000 … in file order).
    The remote's `version` rides along verbatim, so staleness needs no invention of ours:
    Herdr reports it back as `manifest: <path> <version>` and prints `cached_remote_version`
    beside it. The sentinel comment answers only "is this ours to regenerate" — an override
    we did not write is never replaced without `--force`, which is what protects the
    hand-added rules someone may have in theirs.
18. **A `--fork-session` copies the whole conversation and KEEPS EVERY ENTRY'S uuid.**
    Measured: forking a live session left the parent's transcript byte-identical (md5
    unchanged), and the fork's own transcript held the parent's 61 entries rewritten under a
    new session id — of its 57 entries only 4 had a uuid the parent had never seen. That copy
    is what makes an aside cheap and what makes it dangerous: its `toolUseResult` entries are
    the PARENT's writes, so a fork on the board would claim the parent's entire changelist
    and contend with it over every file, which is precisely invariant 10. Hence asides are
    excluded from the board and never diffed, and everything shown of one is derived from
    the entries the parent has never seen. Bookkeeping types (`ai-title`, `mode`,
    `permission-mode`, `last-prompt`, `file-history-snapshot`) carry NO uuid and the fork
    writes fresh copies of them, so any comparison must skip the entries that have none —
    counting them makes a brand-new fork look as though it had already said something.
19. **`agent.start` answers `ok` for a launch that never happened, and the pane it leaves
    is unfindable.** It has only TYPED a command at a shell (invariant 12), so it cannot
    know what that command did: measured at 106–107ms for a launch that worked and for a
    `--resume` of a session that was gone, where `claude` printed "No conversation found
    with session ID" and exited. The pane then holds no agent, which means no board row
    and `agent.get` answering `agent_not_found` — nothing in the cockpit can ever see it
    again. The live session had one, a bare shell where an aside had been forked off a
    conversation that was already cleared.
    **The signal is `agent.get`, and null is not the same as pending.** A launch that dies
    is registered FIRST and dropped after — measured on that doomed `--resume`,
    `launch_pending` at +211ms through +1320ms, then `agent_not_found` from +1726ms on,
    while a real one was still pending past +2640ms. `waitForLaunch`'s old
    `!info?.launch_pending` read those two answers as one, which is exactly how a failed
    start returned a pane id: the aside then typed its question at a shell prompt.
    So every tab is created inside `herdr.launchAgent`, the only thing here that calls
    `tab.create`, and whatever it cannot start it closes — `pane.close` on a tab's only
    pane removes the tab too, verified. Its four primitives are private for that reason: a
    fourth call site cannot re-open the hole. **Uncertainty must answer LAUNCHED**, since
    the alternative closes the pane: a Herdr that stops answering, or a launch still
    pending after 20s, is slow or unreachable rather than dead, and tearing down a running
    agent is far worse than the leak this fixes. Closing the pane also takes the only
    account of what went wrong off the screen, so the last non-prompt line it printed
    travels out in the error instead — "No conversation found with session ID: …" reaches
    the browser rather than a bare 503.

## What enforcement guarantees

**Nothing.** Say so plainly; do not soften it.

Agents run as real `claude` CLI processes started by Herdr, loading the user's own
`~/.claude/settings.json`, which permits `Write(*)`, `Edit(*)`, `Bash(*)`. `server/src/rules.ts`
is injected via `--append-system-prompt`, and that is the entire surface. The `planner`
those rules name is a user-level agent file (`~/.claude/agents/planner.md`) the CLI loads
on its own, so a hand-started agent has it too — and a deleted file leaves rule 4 naming
an agent that does not exist, with nothing to report it. `claudeFiles.ts` ships it, and
`harness init` installs it, which turns "the stranger never had this file" into a
first-run step; it does not make rule 4 enforceable.

**Git is the one rule with an exception, and it is a per-CHECKOUT grant** (`projects.ts`,
`~/.harness/projects.json`). The key is a resolved path and not a workspace id, which is
the same reasoning that keeps a space's dir in memory only — Herdr recycles ids, a path
means the same thing forever, so this is exactly the fact that is safe to persist. The
amendment is appended after the rules it amends and says it extends nowhere else; nothing
stops an agent pushing from a checkout that was never delegated.

**`~/.harness/rules.md` replaces `RULES` wholesale**, read on every `startArgs` and never
cached — the settings screen promises "applies to agents started from now on", and a cached
read would make that a lie in the other direction. Blank or absent means the shipped text,
so emptying the box is a reset rather than a way to start agents with no rules at all, and
a reset DELETES the file rather than writing today's defaults into it, which would freeze
them against every later version.
A `PreToolUse` hook with real force was offered and declined in favour of a smaller system.
Rules 4–7 (plan via subagent, match existing patterns, validate assumptions, minimal change)
are instructions an agent can silently ignore.

Two things are invisible in a diff, both accepted deliberately:
- a file written by a **Bash** command records no tool call;
- a file written by a **subagent**, whose calls go to its own transcript.

The "wrote files while investigating" flag inherits both, so it under-reports a Bash or a
subagent write. It counts from the entry that set the assignment, NOT over the session:
counting the whole session charged an investigation with the writes of the `/feature` it
replaced, which is the one switch the one-slot rule is there to allow.

## Architecture

```
shared/src/index.ts   types + WS protocol, imported by both sides. Keep it ONE file:
                      server (tsx), web (vite alias) and tsc (paths) each resolve it
                      differently, so a second entrypoint means touching three configs.
server/src/
  index.ts            Fastify routes + WS transport. Holds no state.
  herdr.ts            socket client — one-shot requests, one streaming subscription.
                      `launchAgent` is the only thing that creates a tab, and closes
                      one it cannot start an agent in
  transcript.ts       JSONL: slug resolution, incremental tailing, turns, activity, todo
  board.ts            THE JOIN. rows, stateSince, contention, notifications
  diff.ts             per-file diffs from tool results
  history.ts          RECENT — a flat JSON cache of closed agents
  rules.ts            what every started agent is told. Highest-leverage file here.
                      `~/.harness/rules.md` overrides it wholesale; read per start
  log.ts              what a bug report attaches. Always on, file only, capped
  projects.ts         what the human has decided about a CHECKOUT, keyed on its path
  claudeFiles.ts      the planner subagent and the two commands, `harness init`, and
                      the trust grant for the one folder that is ours
  herdrRules.ts       merges our one detection rule into Herdr's current manifest
  aside.ts            side conversations forked off an agent's session
  notify.ts           osascript + afplay, plus a Herdr toast
  instance.ts         the single-instance lock, and where to point the browser
  origin.ts           who may talk to an unauthenticated server. THE security boundary
  usage.ts            the account's limit bars, read through an agent of our own
  invariants.test.ts  the invariants that fail silently, over fixtures only
web/src/
  App.tsx             the one column: collapsible spaces, their agents, inline edits
  Agent.tsx           header, feed|diff tabs, actions, blocked panel
  Feed.tsx            structured feed, turn pagination, subagent nesting
  Status.tsx          StatusDot / Working / Spinner. The one opinion about what
                      "working" looks like — board row, header and panels all read it
  Settings.tsx        rules, checkouts, the Claude files, the Herdr rule. One GET,
                      and every write answers with the whole view back
  Diff.tsx, Markdown.tsx, useHarness.ts
```

## Subagents

The tool is named **`Agent`** (not `Task`). The parent's `toolUseResult` carries `agentId`,
`agentType`, `totalDurationMs`, `totalToolUseCount` and `toolStats` — enough to render the
collapsed row **with no extra file read**. Only expansion opens
`projects/<slug>/<parent-uuid>/subagents/agent-<agentId>.jsonl`, which runs to hundreds of
kilobytes.

## Asides

An **aside** is a side conversation forked off an agent's session with
`--resume <uuid> --fork-session`, for when you are trying to understand what an agent said
and want to ask about it without spending its turn. It is a real Herdr pane and a real
agent; the `aside` button splits the agent view and puts it to the right of the feed, so
the output and the answer are on screen together. Invariant 18 is why it works and why it
is kept off the board.

- **One per parent, found again by NAME, and nothing is remembered.** `aside-<parent pane
  id slugified>` — `w2:pJ` → `aside-w2-pj`. Pane ids are `w<n>:p<base36 UPPERCASE>`, so
  lowercasing cannot collide two panes into one name. Same trick as `usage.ts`: a harness
  restart neither strands an aside nor starts a second.
- **`board.ts` excludes it BEFORE `syncName`.** That rename tracks an agent's terminal
  title, and an instrument renamed off its own name can never be found again. Matched by
  prefix, so an agent a human hand-names `aside-…` would vanish from the board — accepted,
  because a registry of exact pane ids would not survive a restart, which is the whole
  point of the naming.
- **Its STATUS is the one thing of it that reaches the board.** `AgentRow.aside`, a ring
  around the parent's own status dot (`ForkRing`, and the gap between the two is what keeps
  it from reading as a halo on the status colour — a second dot beside it read as another
  status of the agent's), derived by `forkStatuses` in `board.ts` from the fork's
  pane in the snapshot the heartbeat already fetched — so it costs no request, and no row,
  no changelist and no contention are attributed to the fork. Never its transcript: that
  is a copy of the parent's, and reading it for the board IS invariant 18.
  **Herdr's status cannot say whether YOU have read the answer.** `done` means
  idle-after-work-unseen-in-the-terminal and clears when the pane is viewed, and the
  cockpit focuses a pane whenever you open that agent — measured, nine live agents all
  read `idle` bar the one actually working. So the ring is emerald for anything that is not
  `working` or `blocked`, and being unread ends when the fork does, not when you look.
  `cleared` is the trace a dropped fork leaves, so "had one" and "never had one" stay
  distinguishable — DASHED rather than a dimmer colour, because every state is an outline
  now and a grey ring is only a hue apart from a live one; it is remembered per pane in
  memory, dropped with the pane because Herdr recycles pane ids, and empty after a restart
  like `stateSince`. **No ring at all is "never forked", and the box is reserved anyway**:
  a head that changed width would step the whole column in and out as forks come and go.
- **Only the exchange since the fork is shown.** The conversation it was forked with is the
  feed immediately to its left. When the parent's transcript is missing there is no way to
  tell inherited from fresh, and the answer is NOTHING rather than everything — rendering
  "everything" would put the parent's whole conversation beside itself.
- **Two asides that share no uuid are two unrelated conversations**, which means the parent
  has `/clear`ed. The aside is reaped rather than answered from. `board.ts` reports a
  session ending — pane closed OR session id changed — because the panel shuts itself on
  `/clear` and would otherwise never ask again, leaving the fork running.
- **Reforking is closing.** With no aside left, the next question forks afresh from wherever
  the parent has got to, so `refork` and `×` are one route and differ only in whether the
  panel stays open. Closing is `tab.close`, never `/exit`: it ends the agent AND removes the
  pane, where `/exit` costs a turn and leaves a bare shell.
- **It is told to change nothing, and nothing enforces that** — the same standing as
  `/investigate`. So `filesWritten` counts what the fork itself wrote, over the fresh
  entries only, and the panel says `⚠ N files written`. Counting over the whole fork would
  report the parent's files as the aside's.

## Conventions

- **Transcripts are the source of truth**; SQLite is gone and `history.ts` is only a cache.
- **A space's directory is ours, and in memory only.** Herdr has no such field, so `board.ts`
  reads it off the space's panes and keeps hand-set overrides in a `Map`. Do not persist it:
  workspace ids are per-session and Herdr reuses them, so a remembered dir could start an
  agent in the wrong repo. It is why starting an agent needs no form.
- **A row's shade and its locked slot are ours, and in memory only** — the same reasoning as
  the directory above, keyed on a pane id rather than a workspace id. Both are pruned when
  the pane goes, beside `forked`, and both are legitimately empty after a restart like
  `stateSince`. **Applied in `agents()`, never in `resync`:** `history.remember` writes a row
  straight out of `this.rows` to `~/.harness/recent.json`, so either held on the row would
  persist against a pane id Herdr recycles and reappear on whoever inherits it. Kept off the
  row, RECENT carries neither by construction and `history.ts` knows nothing about them.
  **A shade is set by right-clicking the row**, which steps to the next of `AGENT_SHADES` and
  off the end back to none — the array IS the queue, and the browser computes the next value,
  so the route takes a shade rather than a "cycle". They are **distinct hues, not steps of one
  brightness**: a grey wash over a near-black page carries about three distinguishable steps,
  which is what the first attempt was and why it was not distinct enough to scan. The hue
  steps are deliberately NOT uniform — `teal` and `lime` are taken at `-700` where the rest
  are `-500`, because those two are light colours and one alpha across all five made the
  washes differ in brightness as much as in hue, which is the channel selection uses. At
  `-700` all five hold the row's recessive `text-neutral-600` at 1.93–2.06, against 1.94 for
  a selected row before any of this. A shaded row also does not brighten further when
  selected — the `inset-ring` says that instead, and at /45 the greens pass straight through
  the muted text's own luminance and it disappears (measured 1.04 for lime). Amber and
  red are excluded from the queue — blocked status, every `⚠`, error text and the usage bars
  are already those colours, and a row washed in one reads as a claim about the agent, which
  is the one thing a shade must never make.
  **The lock is on an AGENT, never on a space.** Dragging a row by its grip locks that one
  agent at the slot it landed on; clicking the grip locks it where it already sits, or
  releases it. Everything unlocked stays in the attention sort and simply flows around
  whatever is held — so a space is never "ordered", it just has some agents pinned down in
  it. `place()` puts the held ones at their slots and fills the gaps with the rest in the
  order `compare` gave them.
  A slot is an ABSOLUTE position in the space and is clamped to the list as it stands, because
  agents come and go and a slot recorded when the space held six means nothing once it holds
  two. **The newest lock wins a contested slot** and displaces the incumbent to the next gap
  ascending: favouring whoever already held it meant dropping a row onto a locked one moved
  nothing at all, which for the common downward drag left it exactly where it started — a
  dead control, since the insertion line is the gesture's only preview. Recency is the lock
  map's INSERTION order, which is why `lock()` deletes a key before setting it even when it is
  already there — `set` alone leaves the key in place and loses the tie. Only the FACT reaches the
  browser (`AgentRow.locked`), not the slot — an index on the wire would be a second opinion
  about order for the browser to disagree with.
  This is a deliberate exception to the `compare` sort, not to invariant 6: the rows still
  rebuild wholesale every heartbeat and every dot, todo and elapsed time still moves — only
  the held ones' positions are. `arrange()` applies it as a second pass and it must never
  become a clause inside `compare`, which would make that comparator intransitive and let
  `sort` scramble the very slots that were locked. A lock is otherwise invisible, so a locked
  row shows its grip whether or not you are hovering — which is why the grip sits OUTSIDE the
  hover strip, since opacity on the parent cannot be undone by a child — and the `⇅` in the
  space header releases every lock in that space. There is no `WorkspaceRow` flag behind it:
  "does this space hold a locked agent" is read off its rows, not kept in step as a second
  fact.
- **The feed paginates by turn**, never by bytes. A turn runs from one real user message to
  the next — tool results arrive as `user` entries and are not boundaries.
- **User message content is sometimes a bare string**, not an array of blocks.
- **`toolUseResult` is sometimes a string or an array**; only the object form is a write.
- **Unblocking is optimistic**: we send a keystroke without parsing the prompt, then re-read
  the pane. The blocked panel is the one place raw terminal text appears.
  **It must offer arrows, because Enter does not always mean submit.** A `multiSelect`
  AskUserQuestion reads `blocked` like any other prompt, but its Enter TOGGLES the
  highlighted row — measured: a digit ticked Apples, Enter un-ticked it — so digits and
  Enter alone cannot answer it at all. Submit is a row below the options (`↓`) and a tab
  beside them (`→`); Enter on either opens a numbered confirm the digits handle. A
  single-select has no such row and Enter does submit, which is why this failed only
  sometimes. The keys stay plain: a `submit` button sending `right enter` would be parsing
  the prompt by assumption, which is exactly what this panel does not do.
- **Context usage is exact; its window is inferred.** `contextOf` sums `input_tokens +
  cache_read + cache_creation` of the newest non-sidechain `assistant` entry — that IS what
  the model was sent, and a compaction shows up for free as the next request measuring less.
  Zeros are skipped: a failed request records a synthetic all-zero usage. The window is the
  soft half — a transcript says `claude-opus-5` whether the session runs 200k or 1M — so it
  comes from the model in `~/.claude/settings.json` (`[1m]` → 1M, the same file these agents
  load) and widens if any request in the session ever exceeded it. Verified against Claude
  Code's own status line: 83,344/1M read 8%, and the pane footer said `Context: 8% used`.
- **The Tailwind ramp IS the theme, and light mode is one CSS block.** Every colour class
  resolves to `var(--color-*)` — verified in the compiled output, including opacity
  modifiers, which become `color-mix(in oklab, var(--color-teal-700) 35%, …)` inside an
  `@supports` every current browser takes. So `:root.light` in `index.css` redefines the
  ramp and retargets all ~370 class sites at once, and no component knows a theme exists.
  Unlayered rules beat Tailwind's `@layer theme`, so this needs no specificity games. Add a
  colour by picking an existing ramp stop, never a literal, or it will not follow the theme.
  **The light values are not the dark ones mirrored.** Contrast is a ratio of luminances, so
  flipping L* about the midpoint does not preserve it: `text-neutral-700` mirrored falls
  from 2.2 against the page to 1.2 and the dimmest ink all but vanishes. Each neutral is
  instead solved to hold its OWN dark contrast against the page, so the hierarchy is
  identical rather than merely inverted. Accents split by how a stop is USED — 100–600 are
  ink, dots and low-alpha washes; 700–950 are only ever high-alpha washes and the borders on
  them — and no hue uses a stop on both sides. **Neither band may be pair-inverted**, and
  both were caught by measuring rather than by looking. Mirroring the ink band puts
  `text-amber-500` at 2.05, and that stop carries the contention and "wrote files while
  investigating" warnings. Mirroring the wash band keeps each colour but loses its
  COMPOSITE: the `/60` borders fell to 1.10–1.23 against the page, which leaves the ink
  readable and takes the BOX away, so the `/clear` confirm strip and the blocked panel's
  reply input read as borderless. Both bands are solved against the page instead. The two
  `-950` washes are the exception and stay mirrored — they measure 1.03 in dark and 1.00
  here, so they are decorative in both themes and solving them would draw a box the dark
  page never had.
  **The five row shades are solved backwards from the composite.** Their alpha is written
  into the class names (`/25`, `/35`) and cannot be tuned, so each colour is derived from
  one pale tint at a single oklch lightness per hue. They land within 0.03 luminance of each
  other — selection is read by brightness, so they must differ by hue alone — and hold
  `text-neutral-600` at 2.02–2.09 against 1.94 for a selected row, the same band dark
  measures. Amber and red stay out of the queue here too.
  **`index.html` resolves the theme once, before first paint, and that is the only copy of
  the rule** — unset storage follows `prefers-color-scheme` for the life of the page, a
  click wins forever, and unreadable storage falls through to the OS rather than pinning the
  page to dark. `theme.ts` reads the answer back off the class instead of resolving it a
  second time, so it cannot disagree with what is already on screen; it owns only keeping
  that class in step afterwards. Storage is guarded on both sides — blocked site data must
  cost the preference its persistence, never the click or the page. Dark carries no class at
  all; `class="dark"` was removed as dead, since nothing uses a `dark:` variant and v4's is
  media-based anyway.

## Slash commands

`/clear`, `/goal` and `/exit` are sent as ordinary text through `agent.prompt` — Claude Code
parses the leading `/` itself, so nothing server-side needs to know what they mean. All
three are verified working through that path.

- **`/clear` starts a new session**, so the transcript path changes while the pane id does
  not. The agent view is keyed on `paneId:sessionUuid` for exactly this reason — without it
  the feed keeps turns from the old conversation, whose indices restart at 0.
- **`/exit` ends the agent** but leaves the pane. The resync sees a pane with no `agent` and
  moves the row to `RECENT`.
- **`/goal <condition>`** makes Claude keep working unprompted until a fast model judges the
  condition met. `/goal clear` (or stop/off/reset/none/cancel) removes it; `/clear` drops it
  too.
- **`/feature <what to build>`** and **`/investigate <what to look into>`** are user-level
  commands (`~/.claude/commands/feature.md`, `investigate.md`), so they are the human's files
  and not ours. `assignmentOf` reads the newest of the two back off the transcript — the
  ordinary `<command-args>`, no unstable field involved — and the board and the agent header
  show it as one chip beside the goal's: `⚑` sky for a feature, `※` fuchsia for an
  investigation, which also turns the agent's own NAME fuchsia in both places so you can pick
  the investigations out of a column you are scanning. The status dot is deliberately left
  alone — it means status and nothing else. **One slot, newest wins**: an `/investigate`
  replaces a standing `/feature` and vice versa, because each contradicts the other. Neither
  has a completion signal to read, so it stands until the other replaces it or `/clear` ends
  the session: the chip says what the session was set to do, and the todo line under it is
  what moves.
- **`/investigate` is a discussion mode — read the code, report, propose, edit nothing — and
  that is an instruction, not a rule.** Nothing prevents an investigating agent from writing
  a file. What the harness does instead is refuse to let it pass silently: an investigation
  with `filesSince > 0` says `⚠ wrote N files while investigating` on its board row and beside
  its chip in the header. Same spirit as a `stale` hunk — the mess is visible rather than
  hidden.
- **An investigation is left out of the contention join entirely** — `contends()` in
  `board.ts`, applied to both the board rows and the per-file diff warnings. It is not
  modifying anything, so it neither reports a collision nor causes one, and a warning either
  way would be about work that is not happening. It rejoins the moment `filesSince > 0`:
  that collision is real, and dropping it would hide clobbering, which is the one thing
  invariant 10 exists to prevent. Its files from before the `/investigate` sit out with it —
  another agent overwriting one is a `stale` hunk, which is that fact's own signal.

**Reading the goal is the one place we parse an unstable field.** It comes from
`{"type":"attachment","attachment":{"type":"goal_status","met":…,"condition":…}}`, which
Claude Code documents as internal and version-unstable. `goalOf()` validates every field and
returns null on anything unexpected — never let it throw, and never make the board depend on
it. `/goal clear` leaves the last `goal_status` behind, so a more recent clear command wins.

**Slash commands are recorded in TWO different shapes**, and handling only one makes whole
commands vanish from the feed:

- `/clear`, `/goal` → `type: "user"`, text under `message.content`
- `/usage` → `type: "system"`, `subtype: "local_command"`, text at the **top level**
  `content` field

`entryText()` reads both. That is why it exists — do not "simplify" it back to
`message.content`.

**`/usage` writes nothing useful to the transcript.** It draws a terminal dialog; its only
trace is `<local-command-stdout>Settings dialog dismissed</local-command-stdout>`. The
`POST /api/agents/:paneId/usage` route therefore runs it, polls `pane.read` until the panel
appears, and only then sends `escape`. Never send that escape unconditionally — if the
dialog did not open it interrupts whatever the agent was doing.

Two things about that panel, both established on a live pane:

- **The dialog is drawn below a full-width `─` rule with the transcript still visible above
  it.** Returning the pane verbatim therefore returned the agent's own output as "usage".
  `cropPanel` cuts at the LAST rule; a dialog taller than the pane scrolls its own top off,
  and then everything visible is dialog, so finding no rule is not a failure.
- **`% used` does not identify the panel.** A Claude Code status line reads
  `Opus 5 (1M context) | Context: 8% used`, so the old detector matched a pane with no
  dialog open, on the first poll, and pressed escape at an agent that was never in one.
  Match the panel's own phrases (`Current session`/`Current week`, `Resets `, `% of usage`)
  and match them against the CROP, never the raw pane.
- **The reading runs in an agent of ours, never in one doing work.** `usage.ts` keeps a pane
  named `harness-usage` in `~/.harness`, started with no `startArgs()` and hidden from the
  board (Herdr still shows it, labelled `usage`). Borrowing a working agent's pane cost it a
  turn, put a `/usage` in its transcript, and simply failed while it was busy — the dialog
  only opens between turns. The pane is adopted back BY NAME from the snapshot after a
  harness restart, so restarting does not strand one or start a second.
- **It runs in OUR directory because that is the one whose trust dialog we may answer.**
  Claude Code asks "Is this a project you created or one you trust?" the first time it starts
  interactively in an untrusted folder, and an agent sits at that dialog until something
  answers — invisible here twice over, since this pane is off the board, and the `/usage`
  that follows is then typed at a security dialog rather than into a prompt box. `~` was
  never trusted (measured: `hasTrustDialogAccepted: false`, and a live `claude` there raises
  the dialog), so every cold start met it. `trustFolder` in `claudeFiles.ts` grants trust
  the way Claude Code's own untrusted-workspace message says to — `projects[<path>]
  .hasTrustDialogAccepted: true` in `~/.claude.json` — and **the folder is `~/.harness`, never
  `~`, because TRUST IS INHERITED BY EVERY DESCENDANT**: measured, a directory created
  seconds earlier under a trusted parent opens with no dialog, so granting it for the home
  directory would silently trust the human's whole home tree off one button press. The write
  is idempotent and best-effort — the file is Claude Code's, live-written by every running
  agent, so it is left alone unless the flag is actually missing, goes out via a rename
  because that file holds credentials, and a failure costs the dialog rather than the
  reading. `--dangerously-skip-permissions` does NOT skip this dialog; it was measured too.
- **It is kept between readings and closed when the harness exits.** Keeping it is the
  optimisation — ~10s cold against ~1.2s warm — and it stops being one the moment the only
  process that ever talks to this agent has gone, which is when it becomes a tab nobody
  asked for running an agent nobody can see. So the signal handler closes it, bounded at 2s
  because ctrl-C may never hang on a Herdr that went quiet mid-request. Adoption by name
  still covers the harness that does not get to run that — a crash, a `kill -9`. The lookup
  is what makes adoption clean up too: the pane id is only recorded by a READING, so a
  cockpit that adopted an old agent and was closed without anyone pressing the button knows
  of no pane and has to ask for it by name.
  **Asides deliberately do not close with it.** Each holds an exchange a human opened and
  is found again by name when the harness comes back; this one holds nothing.
- **A cold agent opens the dialog before it can fill it in.** Measured: the panel was on
  screen with its heading and no numbers under it, and the 4s poll gave up; the same request
  a moment later answered in 1.2s. Hence one retry — and, on failure only, a blind escape
  first, which is safe HERE precisely because the pane has no turn to interrupt. First
  reading ~10s (the agent has to start), every one after ~1.2s.
- **The route returns the two limit bars, not the panel.** `limitsOf` reads each
  `Current session`/`Current week` heading down to the next one for its `% used` and `Resets`
  line; the cropped text still rides along, and the browser falls back to it when nothing
  parses. The bars are docked at the foot of the board column — usage is an account-wide
  fact that merely happens to be read through one agent's terminal.

**`isMeta: true` marks Claude Code's own generated `user` entries** — the `/clear` caveat,
goal Stop-hook notices. Command output is wrapped in `<local-command-stdout>` instead.
Neither is a human turn; both render as muted `system` lines. Without this filter the feed
shows machine plumbing as though you had typed it.

## Verifying a change

```sh
npm run lint        # oxlint, correctness only. --deny-warnings, so CI fails on one
npm run typecheck   # tsc over all three workspaces
npm test            # node:test over fixtures — no Herdr, no network, no ~/.claude
npm run dev         # server on 4373, Vite on 4374 — open 4374 (4373 says so too)
npm run build       # vite → dist/web, esbuild → dist/server.js
npm start           # the real thing: one process, one port, opens itself
harness init        # the Claude files and the Herdr rule; never clobbers
harness stop        # NOT pkill; probes the lockfile's port before killing anything
```

**The tests cover only what fails SILENTLY** — diff attribution, the prompt box, the
request boundary, the goal parse, the usage crop. That is the whole selection rule: a
wrong answer in any of them looks exactly like a right one on screen. They are pure
functions over fixtures and touch nothing live, so they say the same thing on a machine
with no agents running. **`dist/` does not rebuild itself** — a behaviour verified against
`node dist/server.js` proves nothing until `npm run build` has run, which cost a
confusing half hour when preflight appeared not to fire and was simply not in the bundle.

**Development and the built product take different paths through `index.ts`.** `dist/web/`
sits beside the bundled server, so `new URL('./web/', import.meta.url)` finds it when built
and finds nothing under `server/src/` when not — which is exactly right, because Vite is
serving the page then and this process is only the API it proxies to. There is no
`NODE_ENV`: the presence of the build is the whole signal.

**The server is bundled, not `tsc`-emitted.** `tsc` does not rewrite the `@harness/shared`
path alias, so its output would import a specifier that resolves for nobody; esbuild inlines
shared and leaves `fastify`, `@fastify/static` and `ws` external as real dependencies. That
is also what keeps `shared` one file with three resolvers and no fourth.

**The Herdr protocol moves, and that is a NON-EVENT.** `herdr api schema --json` is
authoritative — it prints the schema bundled with that binary. `herdr.ts` holds a FLOOR
(`PROTOCOL_MIN`) and deliberately no ceiling: below it we refuse, because fields the board
needs may be absent, and above it we simply run. A ceiling was tried and removed — it fired
on version drift rather than on anything broken, so every future Herdr release would raise a
banner meaning nothing and demand a release here to silence it.
The floor rests on measurement, not optimism: 17 → 22 was diffed method by method against
0.9.0's own schema and NOTHING the harness uses changed — all 19 methods, all 10
subscriptions, every parameter. `session.snapshot` stayed flat (multi-machine did not nest
panes behind a machine), `PaneInfo` kept `agent_status` and `agent_session`, and
`state_change_seq` vanishing cost nothing because no code read it. Herdr documents the
contract this follows: clients "should ignore unknown fields and handle unsupported methods
as normal errors."

**Upgrading Herdr does NOT upgrade the running server, and nothing says so.** Measured:
`herdr --version` reported 0.9.0 while the live server was still 0.7.5 on protocol 17 — the
cockpit kept working against the old one, the `herdr` CLI meanwhile refused every command
with a protocol mismatch, and the state was stable and silent. `staleServerWarning` names it
in the banner now. Finishing the upgrade means `herdr server stop` then `herdr server`, and
**stopping exits every pane process** — all agents die, including whichever one is reading
this. Never restart it unasked.

When something behaves unexpectedly, write a small probe against the socket and observe it —
every invariant above came from doing exactly that, and several contradicted what the schema
implied. **A probe that subscribes steals the cockpit's event stream** (invariant 2): finish
with `POST /api/refresh` to hand it back.

## State of the world

Built and verified end to end: the socket client, the join, board rows with live activity,
per-agent diffs, the structured feed with subagent nesting, and every action route. **The UI
is in daily use** — it was unopened for a long time and that line stayed here long after it
stopped being true, which is its own lesson about this file.

Verified against a real protocol-22 server: the board, the range gate, push delivery
(invariant 3 re-probed — dot-named subscribe, underscore pushes), and one-shot requests.

**`@sxergiu/harness` 0.1.0 is published.** It packs to 12 files and ~187 kB, and the tarball
was installed into a clean directory and run — the `bin`
resolves, the externals resolve, and it correctly deferred to the running cockpit. The scope
is the publisher's npm username, given by hand; a scope that is not yours fails at publish
with a 403. A scoped package defaults to RESTRICTED and stops with a 402 that reads like a
paywall and is not one, so `publishConfig.access` pins it public in the manifest rather than
leaving it on a `--access public` flag that only the first publish is ever remembered for.
The links it ships — `homepage`, `bugs`, `repository` — all point at the GitHub repo, which
was private while this was written: publishing ahead of making it public puts three 404s on
the npm page, and npm shows them to everyone but the owner, whose session resolves them.
`npm publish` is the human's.

**An EXACT pin on a runtime dependency ships that exact version to every consumer forever,
and 0.1.0 shipped four high advisories that way.** `@fastify/static` was pinned `8.3.0` by
the original scaffold rather than by any decision, so a caret could never carry a consumer to
a fix: 8.3.0 is vulnerable to path traversal in directory listing, route-guard bypass via
encoded path separators, authorization bypass via non-canonical paths, and route-guard bypass
via path traversal — on a server with no auth whose other routes type into live terminals.
The visible symptom was none of that. It was a `npm warn deprecated glob@11.1.0` on install,
from the deprecation its maintainer applies to every superseded major; `@fastify/static` 8
wants `glob@^11` and 10 wants `^13`, so the warning was the pin showing through. Both are now
carets (`^10.1.3`, `^5.12.1`) like `ws` always was, which is the house style precisely because
it is what lets a fix arrive. Verified after the bump: `glob@13.0.6`, zero advisories, and a
clean-directory install of the tarball warns about nothing.
**The audit and the tree can disagree, so check the tree.** `npm ls` reported `fast-uri`
3.1.7/4.1.4 while the files on disk were 3.1.5/4.1.2 — the lockfile had moved and those
nested copies had not — and reading `npm ls` alone would have called a live advisory fixed.
`npm audit fix` also declines these: it answers `up to date` and changes nothing, where
`npm update <name>` takes them to the fixed versions inside the ranges their parents already
allow. `nanoid` is the same shape and is dev-only — it arrives through `vite` → `postcss` and
`files` ships `dist` alone, so it never reaches a consumer.

**Both stored files are versioned, and they disagree about what to do with a file they
cannot read — deliberately.** `projects.json` DISCARDS anything unrecognised, because the
cost of dropping a grant is re-ticking a box and the cost of misreading one is an agent
committing where it was never allowed to. `recent.json` MIGRATES its pre-version bare array
and drops only rows missing `paneId` or `name`, because it is a cache and the worst a
misread does is show a stale row. Do not make them consistent with each other; the
asymmetry is the reasoning.

**`~/.harness/harness.log` is always on and never on stdout.** `logger: false` still stands
— Fastify is given no logger, and the terminal is as quiet as it was. `log.ts` takes the
four things a report needs (startup versions, preflight notes, Herdr connection drops,
failed actions and routes that threw) to a file truncated at each start and capped at 1 MB.
It is deliberately not a logger: no levels, no transports, nothing structured. Behind a
flag it would not exist when it was wanted, which is the whole reason the gap was worth
closing.

**The linter is `correctness` only, and that is a decision.** `-D suspicious` finds 17
things here and most are wrong about this codebase — including an EXPRESS rule
(`no-async-endpoint-handlers`) firing on Fastify routes, whose advice would break them, and
`no-array-sort` on arrays that were already spread into a fresh copy. A linter whose
findings must be suppressed on day one is one nobody reads by the time it matters. CI runs
lint → typecheck → test → build, the same four in the same order as above.

**THE `os` FIELD IS GONE, and anybody may now install this.** It read `darwin` alone, and
npm enforces that on the ROOT package rather than only on dependencies — measured by setting
it to `win32` on a mac and watching `npm ci --dry-run` answer `EBADPLATFORM`. So the field and
the CI runner were one decision, and they still are: CI is a matrix over `macos-latest`,
`ubuntu-latest` and `windows-latest`, `fail-fast: false`, and that matrix is the only evidence
the claim rests on. Read it for exactly what it says. Every gate is deliberately machine-free,
so a green Windows run means the code builds and the invariants hold there — never that the
cockpit has talked to a live Herdr off macOS, which nothing has.

Four things the platform lock had been hiding, all of which broke before the matrix went
green, and each of which fails in a different way:

- **npm runs scripts through `cmd.exe` on Windows**, where `mkdir -p`, `cp` and an
  unexpanded `*` are not commands. `build:server`'s asset copy is now `build:assets`, one
  `node -e` over `fs.cpSync`, and `npm test` names `invariants.test.ts` outright — the glob
  worked only because a POSIX shell expanded it before node saw it, and node's own glob
  support arrived after the version `engines` declares. A second test file must be added to
  that script by hand; that is the cost of the floor staying at 20.
- **Windows Herdr listens on a NAMED PIPE**, so `~/.config/herdr/herdr.sock` is not merely
  in the wrong place there but the wrong kind of thing. `socketPath()` asks the binary —
  `herdr status server --json` reports the endpoint it would use whether or not a server is
  running (measured: a bogus `HERDR_SOCKET_PATH` came back under `status: not_running`), and
  it resolves `--session`/`HERDR_SESSION`, which this client never knew about. Env var first,
  binary second, the unix default last so a machine with Herdr off PATH is unchanged.
- **`slugForCwd` now eats `\` and `:` as well**, since a `C:\Users\…` cwd resolved no
  transcript at all. That shape is INFERRED from the POSIX slugs on disk, not measured, and
  a wrong guess is silent by construction: the directory just does not exist, which is a
  normal state (invariant 9), so every feed and changelist would read empty with no error.
  Pinned in the test suite for that reason. It deliberately stops short of replacing every
  non-alphanumeric — underscores and spaces are a claim about macOS paths nobody has checked,
  and getting it wrong moves every slug that already works.
- **Windows gets no native alert.** `notify.ts` has no branch and should not grow a
  speculative one: the modern toast API wants a registered AppId and the usual PowerShell
  recipe wants a module Windows does not ship, so anything written there would look like
  support and fail quietly. The Herdr toast is unconditional and is what a Windows user gets.
  `harness init`'s Herdr rule degrades the same honest way — the manifest it merges lives
  under `~/.local/state/herdr`, so Windows reports `no-remote` and everything else installs.

Remaining before it is something a stranger can rely on: the settings screen has never been
rendered in a browser.

The repo is committed and pushed to `github.com/sxergiu/harness`, which is private. The
human makes every commit.
