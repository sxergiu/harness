# Changelog

## 0.2.1

Three fixes, and the first of them is the reason this is worth taking. A feature rides along
with them, which is why the version is arguable — it is a patch because nothing here changes
what the cockpit is for, and the fixes are what you are upgrading for.

### An answer nobody gave

**Upgrade for this one.** Answering a Claude Code dialog in words — the "tell Claude what to
do differently" box, or an `AskUserQuestion` with a *Type something* row — sent the text and
its Enter in the same call. A selection dialog swallows text wholesale: measured on a live
prompt, sending a custom answer left the pane **byte-identical**, digits included, because
only real key presses move that highlight and text arrives as a paste. The Enter riding along
then committed whichever row happened to be highlighted.

So the agent recorded an option as the human's answer — `→ Spaces`, in the case that found
this — while what they actually wrote was discarded unseen. That is not a missed answer. It is
a false one attributed to someone, and it is indistinguishable afterwards from their having
chosen it.

The blocked panel now types, reads the pane, and only then submits. **Refusing is the whole
answer available**, not a shortfall: driving words into the right row means finding it, which
means parsing the prompt, which is the one thing that panel deliberately does not do. So a
swallowed answer comes back as a refusal, your sentence stays in the box rather than being
dropped a second time, and the row you need to highlight first is an arrow key away.

The test is that the screen changed **at all**, never that it holds your words — Claude Code
collapses a paste into `[Pasted text #1 +61 lines]`, so looking for the text would refuse
sends that in fact landed.

### The log an outage was erasing

A Herdr that is not running fails every reconnect with the same ENOENT, and each one was
reported. At roughly 104 bytes a line that is a kilobyte a minute into `~/.harness/harness.log`
— whose 1 MB cap is **not a rotation**. Past it the file records nothing further, so an outage
of under three hours destroyed the one artifact a bug report is built from, by way of the
fault it exists to describe.

Identical consecutive faults are now said once. A viewer arriving mid-outage is unaffected:
the Herdr state is re-sent on every WebSocket connect, so a tab opened during one hears about
it from that rather than from a broadcast it was not there for. The retry also backs off —
1s, 2s, 4s, 8s, then 10s — with the ceiling kept near the board's own 3s heartbeat, because a
longer one would leave the banner saying "disconnected" over a board that is visibly moving.

Three ways the client could end up holding two subscribed sockets are closed with it. By the
event stream's own rule that **only the newest subscriber is fed**, a leaked second stream
means the one Herdr is feeding is the one nobody reads — the board then freezes with the
socket still `connected` and nothing observable saying so.

### One alert per event

Two snapshot passes overlapped when one outlived the heartbeat — the request timeout is 10s
against a 3s beat — and both then read the same unchanged rows, saw the same transition, and
announced it: two desktop alerts, two sounds and two Herdr toasts for one agent going blocked.
The overlapping pass is dropped rather than queued, which costs a beat of freshness and no
correctness.

### Opening a file the agent named

The feature riding along. A file an agent mentions is now a link — in a tool row, in a code
span in its prose, in a code span inside a file already open — and it opens beside the feed,
in the split the fork panel uses, so the output and the file are on screen together.

What it does **not** do, deliberately:

- **It does not serve arbitrary files.** A path the agent wrote is readable wherever it lives,
  because an agent in a checkout editing `~/.claude/…` is ordinary and its changelist already
  lists that file; anything else must resolve inside the agent's own working directory. `..`
  is flattened before anything inspects the path, and the check runs on the resolved **file**
  rather than its directory, so a symlink under the checkout pointing out of it is refused
  rather than followed. Case is not folded — on macOS a differently-cased path therefore reads
  as outside, which is the wrong answer in the safe direction.
- **It does not decide what is safe to open.** Which code spans become links is a *noise*
  control and nothing more; the server re-checks everything sent to it, so the cost of a wrong
  guess there is an underline on a word that is not a file.
- **It does not open a file at a line.** `board.ts:12` is left as plain text rather than
  offered as a link that would silently drop the line.
- **It does not refresh.** A file is read when you open it and when you ask again. Nothing
  reloads under a reader.

### Unchanged

Everything 0.2.0 said about its own limits still holds, and none of the work above tests them.
The CI matrix still proves only that the code builds and the invariants hold on three
platforms — no cockpit has yet talked to a live Herdr off macOS, and every measurement quoted
above was taken on one. The account switch still handles no credentials.

## 0.2.0

Two features, and the first of them changes who can install this at all.

### Installable on Linux and Windows

The package carried `os: ["darwin"]`, and npm enforces that field on the **root** package
rather than only on dependencies — so `npm install` refused outright anywhere else. The field
is gone, and CI is now a matrix over macOS, Linux and Windows with `fail-fast: false`, because
a run that stopped at the first red would say nothing about the other two.

Read that matrix for exactly what it says. Every gate in it is deliberately machine-free — no
Herdr socket, no network, no `~/.claude` — so a green Windows run means the code builds and
the invariants hold there. It does **not** mean the cockpit has talked to a live Herdr off
macOS. Nothing has.

Four things the platform lock had been hiding, each of which failed in a different way:

- **npm runs scripts through `cmd.exe` on Windows**, where `mkdir -p`, `cp` and an unexpanded
  `*` are not commands. The asset copy is now one `node -e` over `fs.cpSync`, and `npm test`
  names its file outright instead of globbing — node's own glob support arrived after the
  version `engines` declares, so a second test file must be added to that script by hand.
- **Windows Herdr listens on a named pipe**, so an assembled `~/.config/herdr/herdr.sock` is
  not merely in the wrong place there but the wrong kind of thing. `socketPath()` asks the
  binary instead: `herdr status server --json` reports the endpoint it would use whether or not
  a server is running, and it resolves `--session`/`HERDR_SESSION`, which this client never
  knew about and previously missed. Env var first, binary second, the unix default last, so a
  machine with Herdr off PATH behaves exactly as before.
- **`slugForCwd` now eats `\` and `:`**, since a `C:\Users\…` cwd resolved no transcript
  directory at all. That shape is *inferred* from the POSIX slugs on disk, not measured, and a
  wrong guess is silent by construction — the directory simply does not exist, which is a
  normal state — so every feed and changelist would read empty with nothing reporting why. It
  is pinned in the test suite for that reason.
- **Windows gets no native desktop alert**, and deliberately no speculative one: the modern
  toast API wants a registered AppId and the usual PowerShell recipe wants a module Windows
  does not ship, so anything written there would look like support and fail quietly. The Herdr
  toast is unconditional and is what a Windows user gets. `harness init`'s Herdr detection rule
  degrades the same honest way — the manifest it merges lives under `~/.local/state/herdr`, so
  Windows reports it found none and everything else installs.

### Switching Claude accounts from the board

One human with two subscriptions spends one of them at a time, and the switch sits at the foot
of the board because that is where the usage bars that prompt it already are.

**It handles no credentials, and that is a decision rather than an oversight.** It drives the
CLI's own surface — `claude auth status --json`, `logout`, `login` — and reads their stdout. It
never touches the keychain slot the tokens live in, nor the `oauthAccount` block in
`~/.claude.json`. Everything else about the feature follows from that, including the browser
step nobody can skip.

- **An account is `email` *and* `orgId`, never the address alone.** One address holds two
  accounts whenever somebody has a personal plan and a seat in an organization, and keying on
  the address alone made the second capture replace the first.
- **Accounts are captured by being signed in, never typed**, so a new one arrives through an
  ordinary login. A stored profile can be renamed; blank resets it to the address.
- **A switch is `logout` then `login`, and the hole between them is unavoidable** — the CLI
  holds one account at a time, so there is nothing to log into until the current one is gone.
  If Herdr fails in that window you are left signed out, and the error names the command to
  type.
- **Completion is "signed in *and* something changed"**, never merely "signed in" — a status
  that lagged a logout would otherwise report the login finished the instant it began.
- **A pending login is settled by somebody reading the view.** There is no timer on the
  server, so there is nothing to cancel on shutdown, on abandon, or on a second switch.
- **Running agents are not touched, and may fail their next request.** The limit bars still
  read the live account only, and nothing ever switches on its own however exhausted a limit
  is.

### Fixed

- The `projects.json` grant fixture in the test suite was keyed with a POSIX-only absolute
  path. `parse` admits a checkout key only in the resolved form it writes one, and `/a` is
  absolute on POSIX but not on Windows — so the Windows leg measured no grant where it
  expected one, and the neighbouring "truthy but not `true`" refusal passed for entirely the
  wrong reason. Production was never affected: a real store is keyed by `resolve()` on the way
  in.

## 0.1.1

- Unpinned `@fastify/static` so a consumer can reach the fixes. An exact pin on a runtime
  dependency ships that exact version forever, and 0.1.0 shipped four high advisories that
  way — on a server with no auth whose other routes type into live terminals.
- Documented the npm install path, and retracted the protocol ceiling: `herdr.ts` holds a
  floor and deliberately no ceiling, so version drift alone no longer raises a banner that
  means nothing.

## 0.1.0

First published release.
