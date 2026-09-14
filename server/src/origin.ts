/**
 * Who is allowed to talk to this server.
 *
 * Its own module because it is the security boundary, and a boundary that
 * cannot be tested in isolation is one nobody will notice breaking: importing
 * `index.ts` starts a server and claims the lockfile, so the predicate has to
 * live somewhere a test can simply call it.
 *
 * There is no auth, so "bound to 127.0.0.1" is the whole model — and in a
 * browser that is weaker than it sounds:
 *
 *  - DNS REBINDING defeats the bind outright. A hostile page points its own
 *    domain at 127.0.0.1 and its requests arrive here looking local; the `Host`
 *    header is what still carries the attacker's name.
 *  - WEBSOCKETS ARE NOT SUBJECT TO CORS. Any page open in the browser could
 *    `new WebSocket('ws://127.0.0.1:4373/ws')` and read the entire board —
 *    agent names, working directories, todo text. The server sends the board
 *    unprompted on connect, so it was pure exfiltration at zero cost.
 */

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The HOSTNAME, never a substring. `http://127.0.0.1.evil.com` contains
 * "127.0.0.1" and is a different machine entirely; parsing is what tells them
 * apart, and a `includes()` test here would be a hole rather than a check.
 */
function hostnameOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    // A bare `host:port` is not a URL, so give it a scheme to parse against.
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return undefined;
  }
}

export function isLocal(value: string | undefined): boolean {
  const h = hostnameOf(value);
  return h !== undefined && LOCAL_HOSTS.has(h);
}

/**
 * Whether a request may be served, from its two headers.
 *
 * The PORT is deliberately not part of this. In development the page is served
 * by Vite on another port and proxied here, so its `Origin` is the Vite one;
 * pinning the port would break `npm run dev` and teach whoever hit it to delete
 * the check. Hostnames are what distinguish local from hostile.
 *
 * A MISSING Origin is allowed. curl, the probe scripts and every non-browser
 * client send none, while browsers always send one on WebSocket and
 * cross-origin requests — so rejecting absence would break each legitimate
 * local tool without stopping a single page.
 */
export function admits(host: string | undefined, origin: string | undefined): boolean {
  if (!isLocal(host)) return false;
  return origin === undefined || isLocal(origin);
}
