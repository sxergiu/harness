import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentRow } from '@harness/shared';

/**
 * Agents whose panes are gone. Herdr forgets them immediately; this remembers
 * enough to keep the row readable — chiefly the transcript path, since that is
 * where the feed and diff still come from.
 *
 * A flat JSON file rather than a database: it is one bounded list for one user
 * on one machine, and it is a cache. Losing it costs only the name/workspace
 * association of closed agents.
 */

const PATH = join(homedir(), '.harness', 'recent.json');
const LIMIT = 100;

/**
 * Bumped when the shape changes in a way an older reader would misread. Unlike
 * `projects.json`, an unversioned file is MIGRATED rather than discarded: the
 * bare array was this file's only format for its whole life, and the two
 * failures are not comparable. A grant misread hands an agent permission it was
 * never given; a cache misread shows a stale row. Losing a hundred of them for
 * nothing is the worse trade here.
 */
const VERSION = 1;

export class History {
  private rows: AgentRow[] = [];

  constructor() {
    try {
      this.rows = parse(readFileSync(PATH, 'utf8'));
    } catch { /* first run, or a file we can no longer read — start empty */ }
  }

  all(): AgentRow[] {
    return this.rows;
  }

  /** Called when a pane disappears. Most recently closed first. */
  remember(row: AgentRow): void {
    // `aside` goes with `contendedWith`, and for the same reason: a fork's
    // status was a claim about now, and a closed agent cannot be forked again.
    const dead: AgentRow = { ...row, live: false, contendedWith: [], aside: null };
    this.rows = [dead, ...this.rows.filter((r) => r.paneId !== row.paneId)].slice(0, LIMIT);
    this.save();
  }

  /** Drop one closed agent from the list. */
  forget(paneId: string): void {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.paneId !== paneId);
    if (this.rows.length !== before) this.save();
  }

  /**
   * Drop them all. Irreversible — the association of a closed agent with its
   * name, space and transcript lives nowhere else. The transcripts themselves
   * stay on disk; only the way back to them is lost.
   */
  clear(): void {
    if (this.rows.length === 0) return;
    this.rows = [];
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(PATH), { recursive: true });
      writeFileSync(PATH, JSON.stringify({ version: VERSION, rows: this.rows }, null, 2));
    } catch { /* history is a convenience; never let it break the server */ }
  }
}

/**
 * Takes the rows it can make sense of and drops the rest, rather than casting
 * the file and finding out in the browser. `paneId` and `name` are the two the
 * column cannot do without — one is the React key and what selection is keyed
 * on, the other is the only thing the row renders — so a row missing either
 * arrives as a blank entry that cannot be clicked or dismissed.
 *
 * Everything else is left unchecked on purpose. Validating the other twenty
 * fields would be restating `AgentRow` in a second place for a cache whose
 * every other field is already rendered defensively.
 */
export function parse(text: string): AgentRow[] {
  const doc = JSON.parse(text) as unknown;
  // A bare array is the pre-version format, and still readable.
  const rows = Array.isArray(doc)
    ? doc
    : typeof doc === 'object' && doc !== null && (doc as { version?: unknown }).version === VERSION
      ? (doc as { rows?: unknown }).rows
      : null;
  if (!Array.isArray(rows)) return [];

  return rows.filter((r: unknown): r is AgentRow =>
    typeof r === 'object' && r !== null
    && typeof (r as AgentRow).paneId === 'string'
    && typeof (r as AgentRow).name === 'string');
}
