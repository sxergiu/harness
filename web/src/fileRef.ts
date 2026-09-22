/**
 * Which inline code spans in an agent's prose are files worth opening, and the
 * handle a component needs to open one.
 *
 * This is a NOISE control and not a security one: `readAgentFile` on the server
 * re-checks everything sent to it, so the cost of a wrong answer here is an
 * underline on a word that is not a file, or none on a word that is. That
 * asymmetry is the whole design — a missed link is nothing, a false link is
 * noise on every row that mentions the word — so every rule below errs toward
 * refusing.
 */

export interface FileViewer {
  /** The agent's cwd, so an absolute reference can be recognised as local. */
  cwd: string;
  /** Called with the path RELATIVE to the cwd, which is what the route takes. */
  open: (relPath: string) => void;
}

/**
 * Extensions worth opening. Deliberately NOT `diff.ts`'s `LANGUAGES`: that table
 * answers "how do I colour this" and wants a language for every entry, while
 * this one answers "is this token worth a click" and wants `.lock` and `.svg`,
 * which have no language at all.
 */
const OPENABLE =
  /\.(md|markdown|txt|json|ya?ml|toml|ini|lock|properties|gradle|css|scss|html?|xml|svg|sql|sh|zsh|ts|tsx|jsx|py|rb|go|rs|java|kt|cs)$/i;

/**
 * `.js` and its variants are the exception, and they need a slash to count.
 * Bare, the extension is far more often a LIBRARY than a file — this codebase's
 * own prose says `node.js` and `highlight.js` — and underlining those on every
 * mention is exactly the noise this file exists to avoid.
 */
const OPENABLE_WITH_DIR = /\.(m|c)?js$/i;

/** The WHOLE span, never a substring of one. `:` is excluded, so `board.ts:12`
 * is not a link: nothing here can open a file AT a line, and offering a link
 * that silently drops the line would be worse than offering none. */
const SHAPE = /^[^\s`'"()[\]{}<>|*?,;:=]+$/;

/**
 * The path a code span names, relative to `cwd`, or null if it is not one.
 *
 * An absolute reference is admitted only when it is under this agent's cwd,
 * because that is the shape an agent's own prose uses for a file in the checkout
 * it is working in. `~/…` and any `..` walk render as plain text instead: the
 * route would refuse them, and a link that cannot work should not be drawn.
 */
export function fileRef(span: string, cwd: string): string | null {
  if (!SHAPE.test(span)) return null;
  if (span.startsWith('-') || span.startsWith('~')) return null;
  if (span.split('/').includes('..')) return null;

  const hasDir = span.includes('/');
  if (!OPENABLE.test(span) && !(hasDir && OPENABLE_WITH_DIR.test(span))) return null;

  if (span.startsWith('/') || /^[A-Za-z]:[\\/]/.test(span)) {
    const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
    return span.startsWith(root) ? span.slice(root.length) : null;
  }
  return span;
}
