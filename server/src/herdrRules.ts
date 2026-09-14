import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HerdrRuleState } from '@harness/shared';

/**
 * Herdr guesses an agent's status from what is on the screen, using a TOML
 * manifest of regex rules it keeps updated from its own servers. Whatever no
 * rule matches falls through to the idle fallback — indistinguishable from a
 * finished turn. The Claude in Chrome site-permission dialog is one of those:
 * it shares no phrase with any existing rule, so an agent waiting on it reads
 * `idle`, the cockpit never shows its blocked panel, and nothing says why.
 *
 * A local manifest fixes it, and the fix has a cost that must be respected
 * rather than hidden: a local file SHADOWS the remote one entirely, so Herdr's
 * own detection updates stop arriving the moment it exists.
 *
 * Which is why this MERGES instead of shipping a copy. A frozen manifest is
 * wrong the day after it is written — measured on the machine this was built
 * on, a hand-made override was pinned to `2026.08.29.1` while the remote had
 * moved to `2026.09.11.1`, and it was silently missing an upstream fix to the
 * Bash approval prompt. Re-running rebuilds against whatever the remote says
 * now, so the shadow stays current instead of aging in place.
 */

const RULE_ID = 'chrome_extension_permission_prompt';

/**
 * The declaration, not the bare id: the header below names the rule too, so a
 * substring test on the id alone would find it in a file's own documentation
 * and conclude the rule was already there.
 */
const RULE_DECL = `id = "${RULE_ID}"`;

/** Whether this file is ours to regenerate, or something the human wrote. */
const SENTINEL = '# harness: merged from Herdr’s remote claude manifest';

const REMOTE = join(homedir(), '.local', 'state', 'herdr', 'agent-detection', 'remote', 'claude.toml');
const OVERRIDE = join(homedir(), '.config', 'herdr', 'agent-detection', 'claude.toml');

const HEADER = `${SENTINEL}
#
# Written by \`harness init\`. Everything below is Herdr's own manifest, verbatim,
# plus one rule at the end: ${RULE_ID}.
#
# This file SHADOWS the remote manifest entirely — Herdr's detection updates
# stop reaching you while it exists. Re-run \`harness init\` to rebuild it from
# the current remote, or delete it once upstream detects the dialog itself.
# \`herdr agent explain <pane> --verbose\` reports which manifest is in force.
`;

/**
 * Appended at the end of the file, and that is safe without parsing any TOML: a
 * new `[[rules]]` header opens a fresh array-of-tables entry and can absorb
 * nothing from the table above it. Position carries no meaning either — the
 * remote's own priorities run 1100, 970, 965, 975, 1000 … in file order, so
 * Herdr resolves by `priority`, not by where the text sits.
 */
export function merge(remote: string, block: string): string {
  return `${HEADER}${remote.endsWith('\n') ? remote : `${remote}\n`}\n${block}`;
}

/** Herdr reports this back as `manifest: <path> <version>`, so it is the honest key. */
export function versionOf(manifest: string): string | null {
  return /^version\s*=\s*"([^"]+)"/m.exec(manifest)?.[1] ?? null;
}

export function isOurs(manifest: string): boolean {
  return manifest.includes(SENTINEL);
}

export type HerdrRuleOutcome =
  /** Written, or rewritten because it was ours and the remote had moved on. */
  | 'wrote'
  /** Someone else's override is there — it may hold rules of their own. */
  | 'kept'
  /** Herdr detects the dialog itself now; an override would only shadow that. */
  | 'upstream'
  /** Herdr has never fetched a manifest here, and we will not invent one. */
  | 'no-remote'
  /** The rule is not beside the bundle — a `dist/` built before the assets. */
  | 'unavailable';

export function herdrRuleState(): HerdrRuleState {
  const override = read(OVERRIDE);
  const remoteVersion = versionOf(read(REMOTE) ?? '');
  const version = override === null ? null : versionOf(override);
  return {
    path: OVERRIDE,
    installed: override !== null,
    ours: override !== null && isOurs(override),
    version,
    remoteVersion,
    stale: version !== null && remoteVersion !== null && version !== remoteVersion,
  };
}

/**
 * `force` is what overwrites an override we did not write. It must stay opt-in:
 * the one on the machine this was developed on carries a second, hand-added
 * rule, and regenerating from the remote would drop it without a trace.
 */
export function installHerdrRule(force = false): { outcome: HerdrRuleOutcome; state: HerdrRuleState } {
  const remote = read(REMOTE);
  if (remote === null) return { outcome: 'no-remote', state: herdrRuleState() };
  // Upstream has it, so an override adds nothing — but ours may still be sitting
  // there shadowing the very updates that brought the rule in. `upstream` is
  // therefore a state the caller has to report, not silence: `state.installed`
  // and `state.ours` say whether there is a file to delete.
  if (remote.includes(RULE_DECL)) return { outcome: 'upstream', state: herdrRuleState() };

  const existing = read(OVERRIDE);
  if (existing !== null && !isOurs(existing) && !force) {
    return { outcome: 'kept', state: herdrRuleState() };
  }

  const block = read(fileURLToPath(new URL('./assets/chrome-permission-rule.toml', import.meta.url)));
  if (block === null) return { outcome: 'unavailable', state: herdrRuleState() };

  mkdirSync(dirname(OVERRIDE), { recursive: true });
  writeFileSync(OVERRIDE, merge(remote, block));
  return { outcome: 'wrote', state: herdrRuleState() };
}

function read(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
