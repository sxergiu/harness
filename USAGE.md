# USAGE

## Prerequisites

Herdr must be running — this cockpit observes it and does nothing on its own. It connects
to `$HERDR_SOCKET_PATH`; failing that it asks your own binary, with
`herdr status server --json`, which reports the endpoint Herdr would use — including a
named session's, and the named pipe it uses on Windows rather than a socket file. Only if
`herdr` is not on your PATH does it fall back to `~/.config/herdr/herdr.sock`. So it can be
started from any terminal, not only from inside a Herdr pane.

It needs **Herdr protocol 17 or newer**. Below that it refuses to start rather than misread
fields it depends on, and the banner says so — `herdr update`. Above it there is no
ceiling: a newer Herdr simply runs. One was tried and removed, because it fired on version
drift rather than on anything broken. `herdr api schema --json` is the authority on what
your binary actually speaks.

## Running it

```sh
npm install -g @sxergiu/harness
harness init
harness
```

From a checkout, where `node dist/server.js` stands in for the `harness` on your path:

```sh
npm install && npm run build
node dist/server.js init
npm start
```

**`harness init` is the first-run step, and skipping it costs you features silently.** It
puts three files where Claude Code reads them: `~/.claude/agents/planner.md`, which the
rules tell every agent to delegate planning to, and `~/.claude/commands/feature.md` and
`investigate.md`, which are what the `feature` and `investigate` buttons run. Without them
an agent is told to call a subagent that does not exist, and nothing reports it.

It also merges one detection rule into Herdr's manifest — see [Blocked detection](#blocked-detection).

It **never overwrites a file you have changed**; it says `kept` and leaves yours alone.
`--force` replaces them. Re-running it is safe and is how you refresh the Herdr rule.

One process on **http://127.0.0.1:4373**, which it opens for you. `Ctrl-C` stops it. That
is the whole thing — the server serves the page itself, so `/api` and `/ws` are same-origin
and there is no second port to remember.

```sh
npm start -- --port 4380   # if something already has 4373
npm start -- --no-open     # don't open a browser
harness stop               # reads the lockfile, so it finds a moved port
harness --version
```

`harness stop` probes the recorded port before it kills anything, so a stale lockfile left
by a crash cannot make it kill an unrelated process that inherited the pid. `⏻` in the
browser does the same thing. Either way **the agents keep running** — they are Herdr's, and
only the cockpit closes.

Do not `pkill` node; that takes your agents with it.

**Only one instance runs.** The lock is `~/.harness/harness.lock`, not the port — so
`--port` cannot accidentally give you two cockpits, which matters more than it sounds:
Herdr feeds pushes only to the newest subscriber, so a second instance would silently and
permanently starve the first of its event stream. Start it twice and the second invocation
just opens the one already running.

If the port is held by something that is **not** a harness, it says so and suggests another
— it will not tell you an instance is running when none is.

### Remote machines

There is no auth, so the cockpit binds `127.0.0.1` and nothing else. To reach one on another
box, forward the port — never change the bind address:

```sh
ssh -L 4373:127.0.0.1:4373 yourbox
```

### Working on it

```sh
npm run dev        # Fastify on 4373, Vite on 4374 — open 4374
```

In development Vite serves the page and proxies `/api` and `/ws` back to the server, so
there are two processes and two ports again. `harness stop` handles the server; quit Vite in
its own terminal.

## Using it

- Agents are listed **under their space** — a Herdr workspace — which collapses with a
  click. A collapsed space with agents wanting you shows an amber count, so nothing you
  need to see can hide behind a fold.
- The **board** is always ordered `blocked → done → working → idle` inside each space, and
  grouping is the only thing that reorders it. The time on each row
  is how long it has been *in that state*, not how old the session is. It reads `—` until
  the first state change the cockpit actually observes, so a fresh start shows no times.
- Each row carries a **context meter** — how full that agent's window is. The number of
  tokens is exact: it is the usage Claude Code recorded for the agent's last request, so a
  compaction shows up on its own as the next request measuring less.
- Click a row for the **feed** (what the agent said and did) and its **diff**.
- The feed opens on the latest turn; **load earlier** walks back one turn at a time.
- Tool calls and subagents are one line each — click to expand. Expanding a subagent reads
  its transcript, which can be hundreds of kilobytes, so it is only read on demand.

### Slash commands

The agent view has **goal** and **clear** buttons, and the prompt box takes slash commands
directly — typing `/clear` there does the same thing as the button.

- **clear** runs `/clear`: a new conversation, discarding the current one. The feed and diff
  reset with it, because `/clear` starts a new transcript. Asks first.
- To **end an agent**, use `✕` on its board row. That closes the tab, which ends the agent
  and removes its pane. (Typing `/exit` in the prompt box still works and leaves the pane
  behind as a bare shell, but there is no button for it — one way out is enough.)
- **goal** sets a `/goal` — a condition Claude keeps working toward on its own, without you
  prompting each turn. An active goal shows as `◎ condition` on the board row and turns
  green when met. The same panel clears it.

- **usage** runs `/usage` and shows the panel in the browser. That command draws a terminal
  dialog and writes nothing usable to the transcript, so the cockpit runs it, waits for the
  panel to appear, reads the pane and dismisses it for you. If the panel never appears it
  says so and sends nothing — a blind escape would have interrupted the agent instead.

A goal is dropped by `/clear` and by ending the session, which is Claude Code's behaviour,
not ours.

> The goal readout comes from a field Claude Code documents as internal and liable to change
> between releases. If a future version stops showing goals on the board, that is why — the
> cockpit degrades to showing nothing rather than guessing.

### When an agent is blocked

The panel shows the pane's **raw terminal text**, because the cockpit does not parse
permission prompts. The key buttons send that keystroke and then re-read the pane so you
can see what actually happened.

This is optimistic on purpose: a mistimed keystroke can land in the agent's prompt box as
literal text. If a prompt looks unusual, use **terminal ↗** to jump to the real pane.

### Spaces, and starting an agent

**`+` on a space starts an agent there immediately** — no name, no directory, no
placement. The directory belongs to the space, which is what makes one click enough:
`agent.start` takes no cwd, so a new tab is created in the space's directory first.

It takes about **four seconds**, and the button shows `·` throughout. That is not slack:
the shell has to reach its prompt before Herdr types the launch command, and the launch has
to finish before the agent can be prompted or renamed at all. When `+` releases, the agent
on the board is one you can actually drive.

A space's directory is read off the panes it already has, and you can override it with
`✎` — which is also where you rename the space. The override lives in memory only: a
workspace id means nothing outside one Herdr session, and Herdr reuses ids, so a
remembered directory could start an agent in the wrong repo.

`✎` on an agent renames it. `+` beside `SPACES` adds a space; rename it right after.

If a space has no directory yet — a brand new one — `+` opens that editor instead of
failing, because the directory is the one thing it cannot guess.

Agents started this way are given the rules in `server/src/rules.ts`. Agents you start by
hand in a terminal are not.

### Letting agents commit and push

Rule 1 is *never commit or push*, everywhere, by default. `✎` on a space has a checkbox
that lifts it for that checkout, and a space with it on shows `git` in its header.

Two things about it that are not obvious and that the cockpit therefore says on screen:

- **It is a property of the checkout, not the space.** It is stored against the resolved
  path in `~/.harness/projects.json` — which is also why it survives a restart where the
  space's directory does not. Point two spaces at one repo and both carry the grant.
- **It applies to agents started afterwards.** The rules go in as a system prompt when the
  agent starts, so unticking the box does not disarm anything already running.

Revoke it from the same checkbox, or from **CHECKOUTS** in `⚙` settings — which is the only
place to reach a checkout whose space has since gone.

### Settings

`⚙` beside `SPACES` opens one screen for everything about the install rather than the
session:

- **RULES** — the whole system prompt every started agent gets, editable, saved to
  `~/.harness/rules.md`. `reset to default` drops the file rather than writing today's
  defaults into it, so a reset keeps following later versions. Applies to agents started
  from then on. It goes in with `--append-system-prompt`: all of it is instruction, none of
  it is enforced.
- **CHECKOUTS** — every checkout git has been delegated in.
- **CLAUDE FILES** — whether `planner.md`, `feature.md` and `investigate.md` are installed,
  missing, or differ from what ships. Install from here or with `harness init`.
- **HERDR** — the blocked-detection rule below.

### Blocked detection

Herdr guesses whether an agent is blocked from what is on the screen, using a manifest of
rules it keeps updated from its own servers. Whatever no rule matches falls through to
*idle* — which looks exactly like a finished turn. The Claude in Chrome permission dialog
is one of those: an agent waiting on one reads idle, and the cockpit never shows its
blocked panel.

`harness init` fixes that by **merging** one rule into a copy of Herdr's current manifest at
`~/.config/herdr/agent-detection/claude.toml`.

> A local manifest **shadows the remote one entirely**, so Herdr's own detection updates
> stop reaching you while it exists. That is why this merges rather than shipping a fixed
> copy, and why the settings screen shows which remote version yours was built from and
> whether Herdr has moved on since. Re-run `harness init` to rebuild it; delete the file
> once upstream detects the dialog itself.

An override it did not write is never replaced without `--force` — yours may carry rules of
your own. `herdr agent explain <pane> --verbose` reports which manifest is actually in force.

### Names

Every agent gets a real Herdr name, derived from its terminal title — **including agents
you started yourself**, which you will see happen in the Herdr UI.

The name **follows the title**: when Claude Code revises its title, the name is renamed to
match, so a row never keeps describing work the agent has moved on from. Rename an agent
yourself, in the browser or the terminal, and the cockpit stops touching it.

> How fresh that name is depends on Claude Code, not on the cockpit. It revises its own
> terminal title only occasionally — sometimes not for an hour — and the cockpit can only
> follow what it publishes. **The genuinely live fields are the two lines under the name:**
> the current todo, and the activity line, which updates on every tool call.

## Troubleshooting

**Board is empty, banner says Herdr disconnected.** Herdr is not running, or its socket
moved. Check `herdr status` and `echo $HERDR_SOCKET_PATH`.

**An agent shows status but no feed or diff.** Its transcript is not on disk — either it
has not started work, or the transcript was pruned. This is expected, not a fault.

**A file you know changed is missing from the diff.** It was written by a Bash command or
by a subagent. Neither records a tool call, and neither can appear. See README.

**A hunk is marked `~ overwritten`.** That change is no longer in the file — another agent
edited over it, or it was reverted. It stays in the changelist on purpose: dropping it
would hide that the work was lost. A `~` beside a filename in the tree means the file has
at least one such hunk.

**Each agent's diff is its own changelist.** One file edited for two different features
appears under both agents, each showing only its own hunks — no line is counted twice, and
neither agent is credited with the other's work.

**Times all show `—`.** The cockpit was restarted and has not yet seen a state change.
Herdr exposes only a counter, never a timestamp, so the clock has to be ours.

**A context meter reads a smaller share than Claude Code's own status line.** The token
count is exact; the *window* it is divided by is inferred, and that is the part that can be
wrong. A transcript says `claude-opus-5` whether the session runs 200k or 1M, so the window
is read from `model` in your `~/.claude/settings.json` — `[1m]` means a million. An agent
started with a different model on the command line, or under a project setting that
overrides the global one, is measured against the wrong window.

It fails safe: the smaller window is assumed, so it over-reports how full an agent is
rather than telling you there is room that is not there. And any single request larger than
the assumed window widens it for that session, so a long agent corrects itself.

**Something went wrong and there is nothing to show for it.** `~/.harness/harness.log` is
written on every run — startup versions, Herdr connection drops, failed actions and any
route that threw. It is truncated at each start, so reproduce first, then read it. Nothing
about it goes to the terminal, which is why you may not have noticed it exists.
