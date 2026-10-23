const PANELS_KEY = 'harness.panels';
const LIMIT = 50;

/**
 * What is open beside an agent's tabs: the fork and the run fork stacked in one
 * column, and the files stacked newest first.
 */
export interface Panels {
  fork: boolean;
  runs: boolean;
  files: string[];
}

const CLOSED: Panels = { fork: false, runs: false, files: [] };

/**
 * Each agent's open panels, kept per pane in this browser so switching agents,
 * a `/clear` and a reload all come back to the same columns. The view remounts
 * on every one of those, so state of its own could survive none of them.
 *
 * Keyed on the PANE ID, which Herdr recycles, so each entry carries the cwd it
 * was saved under and is ignored under any other: the files are paths relative
 * to that cwd, and opening them against another checkout would show a column of
 * not-founds. A recycled pane in the SAME checkout inherits them — a few panels
 * open that nobody asked for here, which `×` answers. Bounded by recency like
 * `shades.json`, and not pruned when a pane goes, for its reason: a Herdr
 * restart looks exactly like every pane going.
 */
type Stored = Record<string, Panels & { cwd: string }>;

/** Unreadable storage, or an entry of a shape we did not write, reads as closed. */
function stored(): Stored {
  try {
    const all: unknown = JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}');
    return all && typeof all === 'object' ? (all as Stored) : {};
  } catch {
    return {};
  }
}

export function panelsOf(paneId: string, cwd: string): Panels {
  const p = stored()[paneId];
  if (!p || p.cwd !== cwd || !Array.isArray(p.files)) return CLOSED;
  return { fork: p.fork === true, runs: p.runs === true, files: p.files.filter((f) => typeof f === 'string') };
}

export function rememberPanels(paneId: string, cwd: string, panels: Panels): void {
  const all = stored();
  // Newest leads the insertion order, which is what `LIMIT` cuts from the back
  // of — and the old entry has to go first or the spread would put it back.
  delete all[paneId];
  const kept = panels.fork || panels.runs || panels.files.length
    ? { [paneId]: { cwd, ...panels }, ...all }
    : all;
  try {
    localStorage.setItem(
      PANELS_KEY,
      JSON.stringify(Object.fromEntries(Object.entries(kept).slice(0, LIMIT))),
    );
  } catch {
    // Unwritable storage costs the panels their persistence, never the click.
  }
}
