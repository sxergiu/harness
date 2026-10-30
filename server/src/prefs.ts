import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Prefs } from '@harness/shared';

/**
 * The page's own switches — theme and copy-on-select — held here rather than in
 * the browser, whose storage is per ORIGIN: see `Prefs`.
 *
 * Takes `shades.json`'s tolerant policy, per field: nothing is authorized by
 * this file, so a value it cannot read is simply never chosen, and the rest
 * still apply.
 */

const PATH = join(homedir(), '.harness', 'prefs.json');
const VERSION = 1;

export class PrefsStore {
  private prefs: Prefs = { theme: null, copyOnSelect: null };

  constructor() {
    try {
      this.prefs = parse(readFileSync(PATH, 'utf8'));
    } catch { /* first run, or a file we can no longer read — nothing chosen */ }
  }

  get(): Prefs {
    return this.prefs;
  }

  set(patch: unknown): Prefs {
    const next = merge(this.prefs, patch);
    this.prefs = next;
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      writeFileSync(PATH, JSON.stringify({ version: VERSION, ...next }, null, 2));
    } catch {
      // Unwritable home costs the choice its persistence, never the click: the
      // value still holds for every tab until the server restarts.
    }
    return next;
  }
}

export function parse(text: string): Prefs {
  const doc = JSON.parse(text) as unknown;
  const none: Prefs = { theme: null, copyOnSelect: null };
  if (typeof doc !== 'object' || doc === null) return none;
  return (doc as { version?: unknown }).version === VERSION ? merge(none, doc) : none;
}

/** Takes from `patch` only the fields that read as a pref, and keeps the rest of `prefs`. */
export function merge(prefs: Prefs, patch: unknown): Prefs {
  const next = { ...prefs };
  if (typeof patch !== 'object' || patch === null) return next;
  const { theme, copyOnSelect } = patch as Record<string, unknown>;
  if (theme === 'light' || theme === 'dark') next.theme = theme;
  if (typeof copyOnSelect === 'boolean') next.copyOnSelect = copyOnSelect;
  return next;
}
