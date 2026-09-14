/**
 * The SQL a tool call ran, pulled back out of its recorded input.
 *
 * A projection of one tool's input into one domain view, which is `diff.ts`'s
 * job rather than `transcript.ts`'s — the transcript module resolves slugs,
 * tails files and builds turns, and none of those is "parse a shell command".
 *
 * Both gates below are load-bearing, measured over the Bash calls in this
 * machine's transcripts:
 *
 * - Dropping the CLIENT gate cost ~80 false cards, nearly all of them `grep`
 *   and `git log --grep` searching FOR sql: `grep -rn "CREATE TABLE …"`.
 * - Dropping the STATEMENT gate let CLIENT alone fire on any line merely
 *   containing `|mysql` or `(psql`, including heredocs that WRITE such a script.
 *
 * The CLIENT gate anchors at a command position, and that anchor has a price
 * paid knowingly: `npm install better-sqlite3` is correctly rejected, but so is
 * `docker exec db psql -c "…"`, which is real and goes uncarded. Widening to a
 * bare word boundary trades that miss back for the `npm install` false positive.
 */

/**
 * A database client at a COMMAND position — not merely somewhere in the line.
 * A newline is one such position: agents write multi-line scripts constantly,
 * and without it `cd /repo\npsql -c "…"` went uncarded.
 */
const CLIENT =
  /(?:^|[;&|(\n]|\$\()\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:psql|mysql|sqlite3|duckdb|clickhouse-client|bq)\b/;

/**
 * A statement, not an English sentence: the keyword must be followed by
 * whitespace, so `select:mcp__foo` and `selection` are both rejected.
 */
const STATEMENT =
  /^\s*(?:with|select|insert|update|delete|create|alter|drop|truncate|explain)\s/i;

/**
 * Keywords that are ordinary English verbs as well as SQL, so they are trusted
 * only once CLIENT has fired. `describe the bug` and `show me the auth flow`
 * both pass a bare keyword test, and a free-text field full of prose would card
 * itself constantly.
 */
const CLIENT_ONLY =
  /^\s*(?:show|describe|desc|analyze|copy|call|merge|grant|revoke|vacuum)\s/i;

/** Every single- or double-quoted run in a command, however many there are. */
const QUOTED = /(['"])([\s\S]*?)\1/g;

/**
 * Extracted from every quoted run rather than from a `-c`/`--query` flag list.
 * Measured: a flag list missed a quarter of real calls, because psql combines
 * short flags — `psql -tAc "SELECT …"` matches no `-c` — and because `sqlite3
 * db "UPDATE …"` passes its statement positionally, behind no flag at all.
 *
 * Several statements in one command are joined and never rewritten: no
 * semicolon stripping, no reflow. Copying the card has to give back what
 * actually ran.
 */
export function sqlOf(name: string, input: Record<string, unknown>): string | null {
  // A field literally named `sql` declares its own intent, so it is taken at
  // its word — no keyword test, which would only reject the statements the
  // keyword lists miss. `query` is deliberately NOT read: it is the field name
  // WebSearch, ToolSearch and the caveman retriever all use for free text, and
  // content alone cannot tell their prose from a statement.
  const declared = input.sql;
  if (typeof declared === 'string' && declared.trim()) return declared.trim();

  if (name !== 'Bash') return null;
  const command = input.command;
  if (typeof command !== 'string' || !CLIENT.test(command)) return null;

  const found: string[] = [];
  for (const [, , body] of command.matchAll(QUOTED)) {
    if (STATEMENT.test(body) || CLIENT_ONLY.test(body)) found.push(body.trim());
  }
  return found.length ? found.join('\n\n') : null;
}
