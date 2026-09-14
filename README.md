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
brew install herdr && brew services start herdr

npm install && npm run build
node dist/server.js init   # installs the planner subagent and the two commands
npm start
```

`init` is not optional busywork: the rules tell every agent to delegate planning to a
`planner` subagent, and the board's feature/investigate chips come from two slash commands.
All three are files in `~/.claude` that this puts there. It never overwrites one you have
changed.

One process on `http://127.0.0.1:4373`, which it opens for you. macOS only — not because
anything here is known to need it, but because nowhere else has ever been run.

See [USAGE.md](USAGE.md). The design and the reasoning behind each decision are in
[SPEC.md](SPEC.md); [CLAUDE.md](CLAUDE.md) is the orientation for an agent working on this
codebase.
