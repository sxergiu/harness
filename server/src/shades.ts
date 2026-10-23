import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_SHADES, type AgentShade } from '@harness/shared';

/**
 * Each row's hand-set tint, kept across a harness restart and a Herdr one.
 *
 * Keyed on the PANE ID, which Herdr recycles, and that is a choice the human
 * made knowingly: a pane id reused for a new agent can come back wearing the
 * last one's colour. A tint makes no claim about the agent, so the cost of that
 * is a wrong wash on a row, never a wrong fact.
 *
 * An entry is NOT dropped when its pane goes. A Herdr restart looks exactly like
 * every pane going and coming back, and pruning on the way out is what would
 * lose every colour across one. The store is bounded by recency instead.
 *
 * Takes `recent.json`'s tolerant policy: nothing is authorized by this file, so
 * an entry it cannot read is dropped and the rest kept.
 */

const PATH = join(homedir(), '.harness', 'shades.json');
const LIMIT = 100;
const VERSION = 1;

export class Shades {
  /** Most recently set first — insertion order is what `LIMIT` cuts. */
  private shades = new Map<string, AgentShade>();

  constructor() {
    try {
      this.shades = parse(readFileSync(PATH, 'utf8'));
    } catch { /* first run, or a file we can no longer read — start with no tints */ }
  }

  get(paneId: string): AgentShade | null {
    return this.shades.get(paneId) ?? null;
  }

  /** Tints one pane, or clears it with `null`. */
  set(paneId: string, shade: AgentShade | null): void {
    if (shade === null) {
      if (this.shades.delete(paneId)) this.save();
      return;
    }
    const rest = [...this.shades].filter(([id]) => id !== paneId);
    this.shades = new Map([[paneId, shade] as const, ...rest].slice(0, LIMIT));
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      const shades = [...this.shades].map(([paneId, shade]) => ({ paneId, shade }));
      writeFileSync(PATH, JSON.stringify({ version: VERSION, shades }, null, 2));
    } catch { /* a tint is a convenience; never let it break the server */ }
  }
}

/**
 * Checked against the runtime `AGENT_SHADES`, as the route is: a shade dropped
 * from that list would otherwise come back off disk as a class `App.tsx` has no
 * entry for. The first entry for a pane wins, since the file is newest first.
 */
export function parse(text: string): Map<string, AgentShade> {
  const doc = JSON.parse(text) as unknown;
  const entries = typeof doc === 'object' && doc !== null && (doc as { version?: unknown }).version === VERSION
    ? (doc as { shades?: unknown }).shades
    : null;
  const out = new Map<string, AgentShade>();
  if (!Array.isArray(entries)) return out;

  for (const e of entries as unknown[]) {
    if (out.size >= LIMIT) break;
    if (typeof e !== 'object' || e === null) continue;
    const { paneId, shade } = e as { paneId?: unknown; shade?: unknown };
    if (typeof paneId !== 'string' || out.has(paneId)) continue;
    if (!(AGENT_SHADES as readonly unknown[]).includes(shade)) continue;
    out.set(paneId, shade as AgentShade);
  }
  return out;
}
