import hljs from 'highlight.js/lib/common';

/**
 * Syntax highlighting to HTML, shared by the diff and by fenced code blocks.
 *
 * Granularity is the caller's business: this takes a string of any size and the
 * cache keys on its full text, so a single line and a whole query cost the same
 * call. The diff feeds it one line at a time for a reason of its own — see
 * `UnifiedHunk`.
 */
const cache = new Map<string, string>();

export function highlight(text: string, language: string | null): string {
  if (!text) return '';
  if (!language || !hljs.getLanguage(language)) return escapeHtml(text);
  // A space separates, and never a literal NUL: one embedded in this source
  // made `file` report it as binary data, and grep and ripgrep then refused to
  // print its matches — the file went invisible to every search. A space cannot
  // collide, because `getLanguage` above has already limited `language` to an
  // hljs id and none contains one.
  const key = `${language} ${text}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: string;
  try {
    out = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    out = escapeHtml(text);
  }
  if (cache.size > 5000) cache.clear();
  cache.set(key, out);
  return out;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
