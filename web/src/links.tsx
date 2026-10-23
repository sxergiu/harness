/**
 * URLs in an agent's text, as links that open in a new tab.
 *
 * `http` and `https` only, and that is the security half of this file: the text
 * is whatever an agent or a tool printed, and an `href` built from it with any
 * other scheme — `javascript:` above all — would run in the cockpit's origin,
 * which can type into every live terminal. The patterns cannot match one.
 *
 * `localhost` needs nothing special: the cockpit is itself on 127.0.0.1, and a
 * new tab to a dev server is an ordinary navigation.
 */

// No backslash: tool output is often JSON, where `http://x/a\nnext` is a URL
// followed by an escaped newline, not one URL.
const BARE = /\bhttps?:\/\/[^\s<>"'`\\]+/g;
const WHOLE = /^https?:\/\/[^\s<>"'`\\]+$/;

/** The URL a code span holds, or null unless the span is one and nothing else. */
export function urlOf(span: string): string | null {
  return WHOLE.test(span) ? span : null;
}

/**
 * Prose punctuation is not part of the URL: `see http://localhost:3000.` ends
 * the sentence, not the path. A closing bracket is kept only when the URL opened
 * one, which is how `(http://host/a_(b))` keeps its own and drops the prose's.
 */
function trim(url: string): string {
  for (;;) {
    const last = url.at(-1)!;
    const open = last === ')' ? '(' : last === ']' ? '[' : null;
    if ('.,;:!?*'.includes(last)) url = url.slice(0, -1);
    else if (open && url.split(open).length < url.split(last).length) url = url.slice(0, -1);
    else return url;
  }
}

/** Plain text with every URL in it made a link. Anything else renders as typed. */
export function Linkified({ text }: { text: string }): React.ReactElement {
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BARE)) {
    const href = trim(m[0]);
    // `http://.` trims down to the bare scheme, which names nowhere.
    if (/^https?:\/\/$/.test(href)) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<ExternalLink key={out.length} href={href}>{href}</ExternalLink>);
    last = m.index + href.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

/**
 * The colour is inherited, so a link in red stderr or an amber code span stays
 * that colour; the underline alone says it can be clicked. Solid, where a file
 * link is dotted — one leaves the cockpit and the other opens beside it.
 */
export function ExternalLink(
  { href, className = '', children }: { href: string; className?: string; children: React.ReactNode },
): React.ReactElement {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 hover:decoration-2 ${className}`}
    >
      {children}
    </a>
  );
}
