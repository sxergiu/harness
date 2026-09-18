# harness

A browser cockpit for the coding agents already running in [Herdr](https://herdr.dev).

Herdr runs the agents in terminal panes. This shows you all of them at once, sorted by
which one needs you — with a structured view of what each is doing, a per-agent diff, and
notifications when one blocks, finishes, or dies.

It runs on `127.0.0.1` for one person on one machine. It is never deployed.

```
┌────────┬───────────────────────────────────┐
│ SPACES │ ⬤ debug-missing-uuid  web.app 12m │
│ ▸ all  │   ▸ patch catalogue serializer    │
│  w2 ·1 │   edit src/catalogue/mapper.ts    │
│  w4 ·4 │ ◑ harness            harness  2m  │
│ RECENT │ ○ run-onboarding     web.app 18m  │
└────────┴───────────────────────────────────┘
```

## What it does

- **A board of every agent**, always sorted `blocked → done → working → idle`. Each row
  shows what the agent is doing in words, its current todo, and how long it has been in
  that state.
- **A structured feed** built from the agent's own transcript — prose as prose, each tool
  call as one line you can open, each subagent as one line you can open into its own feed.
  It is not a terminal mirror.
- **A per-agent diff**, built from that agent's own `Write`/`Edit` results.
- **Actions**: prompt an agent, interrupt it, answer one that is blocked, start a new one,
  jump to its real terminal pane.
- **Notifications** on blocked / finished / died, as both a native alert and a Herdr toast.

## What it guarantees

Be clear about this, because the tool it replaced claimed more.

**It guarantees nothing about agent behaviour.** Agents are ordinary `claude` CLI processes
started by Herdr. They load your `~/.claude/settings.json`, which permits `Write`, `Edit`
and `Bash` without restriction. There is no permission gate, no scope lock, and no sandbox
here. This is a cockpit, not a cage.

`server/src/rules.ts` is injected into every agent the cockpit starts — never commit, keep
todos current, plan via a subagent, match existing patterns, validate assumptions, keep
changes minimal. Those are **instructions**. An agent can ignore all of them silently, and
nothing reports it. You can rewrite them all in `⚙` settings; that changes what agents are
told, not what they can do.

The one rule with an exception is the first. Git is delegated **per checkout**, off by
default, from a checkbox on the space — so an agent that publishes your blog cannot commit
to a work repo. The exception is scoped in the prompt and the grant is stored against the
directory, but it is an instruction like the rest: nothing stops an agent running `git push`
in a checkout that was never delegated.

**The diff is accurate but incomplete.** It is built from recorded tool calls, so a tree
that was already dirty is never blamed on an agent. But two kinds of write leave no tool
call and are therefore invisible:

- anything written by a **Bash** command (`sed -i`, `npm install`, a codegen script);
- anything written by a **subagent**, whose calls go to its own transcript.

Several agents share one checkout, so the cockpit flags a file two live agents have both
written. That is a warning, not a lock — nothing prevents them colliding.

**Your transcripts are not an archive.** Claude Code prunes them on a retention timer. A
closed agent stays in `RECENT` and stays readable until its transcript is pruned, then the
row remains and the content is gone.

## Getting started

Herdr must be installed and running — this observes it and does nothing on its own.

```sh
brew install herdr && brew services start herdr   # or see herdr.dev for Linux and Windows

npm install -g @sxergiu/harness
harness init   # installs the planner subagent and the two commands
harness
```

`harness` is the whole command surface: `harness` runs it, `harness stop` ends it, and
`harness --port <n>` moves it off 4373. From a checkout instead, where you build it
yourself and `node dist/server.js` stands in for the `harness` on your path:

```sh
npm install && npm run build
node dist/server.js init
npm start
```

### What `init` installs

Three files, and they are what the rest of this leans on: the rules tell every agent to
delegate planning to a `planner` subagent, and the board's feature/investigate chips are
read back off whichever of the two commands a session was given.

- **`~/.claude/agents/planner.md`** — a read-only planner subagent. It maps the code that
  matters, reports the patterns already in use nearby, validates each assumption against
  the real system and says which it could not, and returns the smallest coherent change.
  It never edits anything.
- **`~/.claude/commands/feature.md`** — `/feature <what to build>`. Scope by questioning
  the human first, then plan, implement, review and file the work as commit-sized
  changelists. It never commits.
- **`~/.claude/commands/investigate.md`** — `/investigate <what to look into>`. Read the
  code and discuss it; the conversation is the output and nothing is written. That is an
  instruction, not a restriction — if the session writes anyway, the board says so.

They are ordinary Claude Code files, so a hand-started agent gets them too. `init` writes
only what is missing and never overwrites one you have changed; `--force` replaces them.

One process on `http://127.0.0.1:4373`, which it opens for you.

### Platforms

**macOS, Linux and Windows — installable on all three, used daily on one.** The package
carried a `darwin` lock that made `npm install` refuse anywhere else; it is gone, and CI
now runs the same four gates on all three runners. Be clear about what that proves: those
gates are deliberately machine-free, so a green Windows run says the code builds and the
invariants hold, not that this cockpit has ever talked to a live Herdr there. Herdr itself
ships for all three.

Three things are known to differ, none of which stops it running:

- **Desktop alerts are macOS and Linux only** — `osascript` and `notify-send`. Windows gets
  the Herdr toast in the terminal and no native alert, because raising one from a plain
  process needs a module Windows does not ship.
- **`harness init`'s Herdr detection rule needs Herdr's manifest**, which it looks for under
  `~/.local/state/herdr`. On Windows it reports that it found none; everything else installs.
- **The Linux and Windows paths have never been run.** Where something is inferred rather
  than measured — the Windows form of a transcript directory name, most of all — the code
  says so at the line it matters.

See [USAGE.md](USAGE.md). The design and the reasoning behind each decision are in
[SPEC.md](SPEC.md); [CLAUDE.md](CLAUDE.md) is the orientation for an agent working on this
codebase.
