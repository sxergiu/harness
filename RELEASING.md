# RELEASING.md — how a version gets out of here

Read [CLAUDE.md](CLAUDE.md) first. This is the procedure that sits on top of it: how the work
between two versions is split, branched, reviewed, merged, tagged and handed over.

## The rule that shapes everything below

**`npm publish` is the human's. Everything else here depends on whether git is delegated to
you in the checkout you are standing in**, and you must know which before you touch anything.

Where it is **not** delegated — the default, and what CLAUDE.md means by "The human makes
every commit" — every `git` line in this file that writes anything is a line for the human to
run. Your job is to get the tree, the notes and the branch into the state where running it is
the only thing left: prepare, verify, hand over the exact command, stop.

Where it **is** delegated, you run those lines yourself. What the delegation hands over is the
typing, and nothing else. It does not hand over **what** to commit, and specifically it is not
permission to skip the split in §1–3: a grant to push is not a grant to decide a release needs
no review. 0.3.0 is the whole reason this section reads this way — the grant was real, the
seven pull requests it still required were not opened, and the release went to `master` as one
commit of 1,576 lines that nobody could review.

This section used to open `You do not commit, tag, push, or publish`, which was false in a
delegated checkout. That is worth naming rather than quietly rewriting: **a document whose
first rule is visibly void reads as advisory all the way down**, and that is the state the
rest of this file was read in when it was ignored.

## What a release is here

One version, made of a **list of features and a list of fixes** decided up front. Each item
gets its own branch and its own pull request. Nothing lands on `master` except through one.

Versioning is plain semver against what a consumer sees:

- **patch** — fixes only, no new surface. 0.2.2 was test-only and still got one, because the
  reason to take it (the Windows leg was red) is a reason.
- **minor** — anything new on the board, the API or the CLI.
- **major** — not yet used.

## 1. Split the release

Before any branch exists, write the list. A feature is a thing a human can see the harness
doing that it did not do before; a fix is a thing that was wrong. Group small fixes that touch
one area into one item — three unrelated one-liners across three files are one branch, not
three.

Post the list before you start. It is the thing the human corrects cheaply, and the branch
names come straight off it.

## 2. One branch per item

```
feat/<slug>        a feature, or a group of fixes under one area
```

Existing examples: `feat/file-panel`, `feat/account-switching`, `feat/windows-and-linux`.

**At least three commits on a feature branch.** Not ceremony — a feature that cannot be told
as three steps is usually one commit doing three things, and the review of it is a diff nobody
can hold. The order that works here is the one the merged history shows: the mechanism first,
then the thing that uses it, then the fixes found while using it.

**A small fix may be one or two.** That is the exception and it is for genuinely small: a
wrong constant, a fixture built the wrong way. If you are reaching for the exception to avoid
splitting, split.

### Commit messages

`[area][topic] lowercase sentence saying what changed, in the present tense`

Areas in use: `server`, `web`, `shared`, `build`, `ci`, `tests`, `docs`. Topics are the
subsystem — `herdr`, `board`, `transcript`, `account`, `platform`, `publish`, `files`.

```
[server][herdr] look at the pane before pressing Enter on a human's words
[tests][platform] build the containment fixtures with the platform separator
```

Say what it does, not what it is. The subject line is the only part most people read.

### Before the branch is offered for review

The four gates, in this order, the same four CI runs:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run build` is last and is not redundant: `dist/` does not rebuild itself, so it is the
only gate that catches a build the other three are happy with.

**If you added a test file, add it to the `test` script by hand.** `npm test` names its files
outright (`invariants.test.ts chrome.test.ts`) because Windows has no shell glob. A test file
nobody runs reports nothing, and reporting nothing looks exactly like passing — `invariants.test.ts`
has a check that fails until the new file is named there.

## 3. Pull request, then squash

One PR per branch, into `master`. The body says what the item is and what it does not cover;
the known-and-not-fixed paragraph in `releases/0.2.2.md` is the tone.

**CI must be green on all three platforms.** The matrix is macOS, Linux and Windows with
`fail-fast: false`, and it is the only evidence behind the claim that anybody may install this.
A red Windows leg is not a flake to re-run, it is the release's Windows claim being false —
that is what 0.2.2 exists to fix.

**Merge by squash**, so `master` gets one commit per item with the PR number appended:

```
[web][files] open a file the agent named, and three fixes under it (#3)
```

`gh` is installed (2.101.0). Prepare the command; the human runs it:

```sh
gh pr create --base master --head feat/<slug> --title "<subject>" --body-file <notes>
gh pr checks --watch
gh pr merge --squash --delete-branch
```

`--delete-branch` is why step 4 is mostly bookkeeping: a squash-merge through `gh` takes the
remote branch with it. **Check `gh auth status` before writing any `gh` line into a
hand-over** — it currently reports no logged-in host, and every command above fails until
`gh auth login` has been run once.

## 4. Clean up the stale branches

`gh pr merge --delete-branch` already removed the remote branch of anything merged that way.
What is left is the local copy, and any branch that predates this process — `feat/file-panel`,
`feat/account-switching` and `feat/windows-and-linux` are all fully merged and still on the
remote today.

Confirm before proposing deletion — a branch with commits not in `master` is not stale, it is
unfinished:

```sh
git log --oneline master..feat/<slug>     # empty means fully merged
```

Then, for the human:

```sh
git branch -d feat/<slug>
git push origin --delete feat/<slug>
```

Release branches (`harness-<version>`) are kept. They are the record of what each published
version was.

## 5. The release commit

One commit, subject `[build][publish] release <version>, <what it is about>`, on a
`release/<version>` branch and merged by its own PR like everything else — so CI has run on
the exact tree the tag will point at, rather than after the fact.

It touches exactly four things:

1. **`package.json`** — `version`.
2. **`package-lock.json`** — same version, via `npm install --package-lock-only`. This is
   drifting right now: the lock says `0.2.0` while `package.json` says `0.3.0`, and 0.2.1 and
   0.2.2 never updated it either. `npm ci` does not check the root version, so it fails
   silently and forever.
3. **`releases/<version>.md`** — the notes. One file per release, holding only what is new in
   that one.
4. **`CHANGELOG.md`** — one new row in the index table, linking to that file. The index is
   deliberately not a second copy of the notes.

### Writing the notes

Read `releases/0.2.1.md` and `releases/0.2.2.md` before writing a new one. What makes them
work:

- **Lead with the thing somebody was hit by**, not the biggest diff.
- **One `##` section per item**, titled as the problem rather than the patch.
- Say what was **measured**. Numbers, the exact wrong behaviour, what was observed.
- Say what was **not** fixed. `0.2.2` has a "Known, and not fixed here" section and it is the
  most useful part of the file.
- Say when production was never affected, plainly, rather than letting a fix imply an outage.

### One thing to fix in the next release commit

**`releases/` has never been committed.** Not ignored — untracked, all six files, since the
split out of `CHANGELOG.md`. So every link in the changelog index is a 404 on GitHub for
everyone, and the files reach npm only because `npm publish` packs the working directory. The
next release commit must add the back-filled `0.1.0`–`0.2.2` notes along with its own, or the
index keeps pointing at nothing.

## 6. Release branch, tag, GitHub release

The branch and the tag are both pointers at the release commit, which is on `master`. For the
human:

```sh
git branch harness-<version>
git tag v<version>
git push origin master harness-<version> v<version>
```

Then the GitHub release, **named `v<version>`, with `releases/<version>.md` as the body
verbatim**. Three things have to say the same words — the notes file, the tag's release, and
the changelog row — and the way they stay in agreement is that there is one place to write
them.

```sh
gh release create v<version> --title "v<version>" --notes-file releases/<version>.md
```

**Check the Actions run on the release commit before going further.** `ci.yml` triggers on
pushes to `master`, so the release commit gets its own run across all three platforms. A tag
that is pushed ahead of a red run is a published version with a red badge.

## 7. Publish

**The human runs `npm publish`.** Never you, and it is not a thing to offer to do.

`prepublishOnly` re-runs lint, typecheck, test and build, so a broken tree cannot reach npm by
that route. What it does not check is that the version is unpublished, that the tag exists, or
that the notes were written — steps 5 and 6 are the only thing standing there.

After it lands, `npm view @sxergiu/harness version` is the confirmation.

## The checklist

```
[ ] release split into a list of features and fixes, posted, corrected
[ ] each item on feat/<slug>, >=3 commits (1-2 only for a genuinely small fix)
[ ] new test files named in the `test` script
[ ] four gates green locally on every branch
[ ] one PR per item, CI green on macOS + Linux + Windows
[ ] squash-merged into master with (#N)
[ ] stale feat/* branches deleted, local and remote
[ ] release commit: package.json, package-lock.json, releases/<v>.md, CHANGELOG.md row
[ ] releases/ actually tracked by git
[ ] Actions green on the release commit
[ ] harness-<v> branch + v<v> tag pushed
[ ] GitHub release v<v>, body = releases/<v>.md
[ ] human publishes to npm
```
