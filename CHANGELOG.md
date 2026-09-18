# Changelog

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
