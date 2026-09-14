import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeFileState } from '@harness/shared';

/**
 * The files `rules.ts` depends on but cannot carry. Rule 4 tells every agent to
 * delegate planning to a `planner` subagent, and Claude Code loads that from
 * `~/.claude/agents/planner.md` — a file on the human's machine, not something
 * this process can pass. Passing the same prompt as `--agents` JSON was tried
 * and gives it only to agents the cockpit started, which is the wrong half.
 *
 * The same goes for `/feature` and `/investigate`: the board reads an
 * assignment back off the transcript and shows it as a chip, so without the
 * command files that whole surface is inert.
 *
 * So they ship, and `harness init` puts them where Claude Code looks.
 */

/**
 * Beside this module in the source tree and beside the bundle in `dist/` —
 * `import.meta.url` is left alone by esbuild, which is the same trick `webRoot`
 * in `index.ts` already relies on for the built page.
 *
 * Read as files rather than imported as text: a text loader works under esbuild
 * and breaks `tsx`, and `tsx` is `npm run dev`, `npm test` and the server's own
 * start script. That is the three-resolver trap the shared package is kept to
 * one file to avoid.
 */
const ASSETS = new URL('./assets/', import.meta.url);

/** Where Claude Code looks. `agents/` and `commands/` are its own convention. */
const FILES = [
  { asset: 'planner.md', target: join('agents', 'planner.md') },
  { asset: 'feature.md', target: join('commands', 'feature.md') },
  { asset: 'investigate.md', target: join('commands', 'investigate.md') },
] as const;

/**
 * `wrote` — it was missing, or force replaced it. `identical` — already ours.
 * `kept` — the human's own version is there and differs, so it stands.
 */
export type Outcome = 'wrote' | 'identical' | 'kept';

/**
 * Pure so it can be tested without a home directory, and small enough to read
 * in one go — overwriting someone's own `planner.md` is silent and theirs to
 * discover, so the decision is worth being able to see whole.
 */
export function decide(existing: string | null, shipped: string, force: boolean): Outcome {
  if (existing === null) return 'wrote';
  if (existing === shipped) return 'identical';
  return force ? 'wrote' : 'kept';
}

export function claudeFiles(): ClaudeFileState[] {
  return FILES.map(({ asset, target }) => {
    const path = join(homedir(), '.claude', target);
    const text = assetText(asset);
    const existing = read(path);
    // `unavailable` is a broken install of the harness rather than a fact about
    // the human's file, and it must not throw: one read feeds all four panels of
    // the settings screen, so an asset missing from the build would otherwise
    // black out rules and checkouts too.
    if (text === null) return { name: target, path, status: 'unavailable' };
    return {
      name: target,
      path,
      status: existing === null ? 'missing' : existing === text ? 'ours' : 'differs',
    };
  });
}

/**
 * Writes every file that is missing, keeps every one the human has changed.
 * Returns what happened to each, because "kept" is the interesting answer and
 * silence about it would read as success.
 */
export function installClaudeFiles(
  force = false,
): Array<ClaudeFileState & { outcome: Outcome | 'unavailable' }> {
  return FILES.map(({ asset, target }) => {
    const path = join(homedir(), '.claude', target);
    const text = assetText(asset);
    if (text === null) {
      return { name: target, path, status: 'unavailable', outcome: 'unavailable' };
    }
    const existing = read(path);
    const outcome = decide(existing, text, force);
    if (outcome === 'wrote') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    return { name: target, path, status: outcome === 'kept' ? 'differs' : 'ours', outcome };
  });
}

/**
 * Accept Claude Code's workspace trust for a folder, ahead of starting an agent
 * in it. Only ever called with a folder the harness itself owns.
 *
 * Claude Code asks "Is this a project you created or one you trust?" the first
 * time it starts interactively anywhere untrusted, and the agent sits at that
 * dialog until something answers. For the usage agent that is invisible twice
 * over — it is kept off the board on purpose — and the `/usage` that follows is
 * typed at a security dialog rather than into a prompt box, where Enter lands
 * on whichever option the dialog happens to default to.
 *
 * Claude Code names this exact escape itself, in the message it prints when a
 * workspace is untrusted: run it here once and accept, "or set
 * projects[<path>].hasTrustDialogAccepted: true in ~/.claude.json".
 *
 * **TRUST IS INHERITED BY EVERY DESCENDANT.** Measured: a directory created
 * seconds earlier under a trusted one opens with no dialog at all, while the
 * same directory under an untrusted parent shows it. So the folder granted here
 * is `~/.harness` and never the home directory the usage agent used to run in —
 * that grant would have silently trusted the human's entire home tree, which is
 * their decision to make and not a side effect of pressing a button.
 *
 * Best-effort and idempotent. The file is Claude Code's own and every running
 * agent writes it, so it is left completely alone unless the flag is actually
 * missing — in practice one write, ever. A file that is absent or unparseable
 * is not ours to create: no Claude Code has run yet, so the trust dialog is the
 * least of what the agent is about to meet.
 */
export function trustFolder(dir: string): void {
  const path = join(homedir(), '.claude.json');
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
      projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    const projects = (config.projects ??= {});
    const project = (projects[dir] ??= {});
    if (project.hasTrustDialogAccepted === true) return;
    project.hasTrustDialogAccepted = true;

    // Rename, so an agent reading it mid-write gets the old file rather than
    // half of the new one — this is where its credentials live.
    const tmp = `${path}.harness-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Falls back to the dialog, which is where this started.
  }
}

/** Null when the assets are not beside the bundle — a `dist/` built before them. */
function assetText(asset: string): string | null {
  return read(fileURLToPath(new URL(asset, ASSETS)));
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
