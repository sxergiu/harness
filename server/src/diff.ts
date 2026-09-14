import { readFileSync, existsSync, statSync } from 'node:fs';
import { relative, extname, sep } from 'node:path';
import type { AgentDiff, DiffFile, DiffHunk, DiffLine } from '@harness/shared';
import type { Entry } from './transcript.js';

/** 2 MB. Past this we report the file rather than diffing it. */
const MAX_DIFF_BYTES = 2 * 1024 * 1024;

const LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.java': 'java', '.kt': 'kotlin',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.cs': 'csharp',
  '.sql': 'sql', '.sh': 'bash', '.zsh': 'bash', '.json': 'json', '.yml': 'yaml',
  '.yaml': 'yaml', '.xml': 'xml', '.html': 'xml', '.css': 'css', '.scss': 'scss',
  '.md': 'markdown', '.properties': 'properties', '.gradle': 'gradle', '.toml': 'ini',
};

interface Recorded {
  /** This agent's own hunks, in the order it made them. */
  hunks: DiffHunk[];
  created: boolean;
  order: number;
}

/**
 * One agent's changelist: the hunks THIS agent wrote, and nothing else.
 *
 * Built from the `structuredPatch` each Edit records, not by diffing against
 * the file on disk. That distinction is the whole point when several agents
 * share a checkout. Diffing against disk attributes every other agent's work to
 * whoever happened to create the file — measured here, one agent claimed
 * `create +349 −0` on a 349-line file while a second claimed `+105 −14` of the
 * same lines, so the same additions appeared in two changelists at once.
 *
 * The consequence to understand: these hunks describe what the agent DID, not
 * what the file looks like now. A hunk another agent has since overwritten is
 * still reported, flagged `stale` — losing it would hide the fact that the work
 * was clobbered.
 *
 * Line numbers are as-of-that-edit. Later edits by anyone shift them, and they
 * are not recomputed; treat them as provenance, not as coordinates.
 *
 * Known blind spot: a file written by a Bash command records no tool result and
 * is therefore invisible here. So is a write made by a subagent, whose calls go
 * to its own transcript rather than this one.
 */
export function buildAgentDiff(entries: Entry[], projectRoot: string): AgentDiff {
  const byPath = new Map<string, Recorded>();
  let order = 0;

  for (const msg of entries) {
    if (msg.type !== 'user') continue;
    // toolUseResult is sometimes a bare string and sometimes an array; only the
    // object form records a file write.
    const raw = msg.toolUseResult;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const result = raw as { filePath?: unknown; type?: unknown; content?: unknown; structuredPatch?: unknown };
    if (typeof result.filePath !== 'string') continue;

    let rec = byPath.get(result.filePath);
    if (!rec) {
      rec = { hunks: [], created: false, order: order++ };
      byPath.set(result.filePath, rec);
    }

    if (result.type === 'create') {
      // A create records no patch, only the content it wrote.
      rec.created = true;
      rec.hunks.push(...wholeFileHunk(typeof result.content === 'string' ? result.content : ''));
      continue;
    }
    rec.hunks.push(...normaliseHunks(result.structuredPatch));
  }

  const files: DiffFile[] = [];
  for (const [path, rec] of [...byPath].sort((a, b) => a[1].order - b[1].order)) {
    files.push(fileFor(path, rec, projectRoot));
  }
  return { files };
}

function fileFor(path: string, rec: Recorded, projectRoot: string): DiffFile {
  const relPath = relative(projectRoot, path).split(sep).join('/') || path;
  const language = LANGUAGES[extname(path).toLowerCase()] ?? null;

  let additions = 0;
  let deletions = 0;
  for (const h of rec.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'add') additions += 1;
      else if (l.kind === 'del') deletions += 1;
    }
  }

  const base: DiffFile = {
    path, relPath,
    kind: rec.created ? 'create' : 'update',
    language, additions, deletions, hunks: rec.hunks,
  };

  // The current file is read only to decide staleness. The hunks themselves no
  // longer depend on it, so an unreadable file still yields a full changelist.
  if (!existsSync(path)) {
    return {
      ...base,
      kind: 'missing',
      hunks: rec.hunks.map((h) => ({ ...h, stale: true })),
      note: 'This file is no longer on disk.',
    };
  }

  let size = 0;
  try { size = statSync(path).size; } catch { /* fall through */ }
  if (size > MAX_DIFF_BYTES) {
    return { ...base, note: `File is ${(size / 1024 / 1024).toFixed(1)} MB — not checked against disk.` };
  }

  let current: string;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    return { ...base, note: 'File could not be read as UTF-8 (binary?).' };
  }

  return { ...base, hunks: rec.hunks.map((h) => ({ ...h, stale: isStale(h, current) })) };
}

/**
 * Whether the file has moved on from what this hunk did. A substring test, not
 * a rebase: it answers "is my change still there?", which is what a reviewer
 * needs to know when two agents edit one file.
 */
function isStale(hunk: DiffHunk, current: string): boolean {
  // The whole-file hunk of a create is exempt. Any later edit by anyone makes
  // the original content no longer match, so testing it would flag every
  // created file as stale the moment it was touched — true, and useless.
  if (hunk.oldStart === 0 && hunk.oldLines === 0) return false;

  const added = runsOf(hunk, 'add');
  if (added.length > 0) return added.some((run) => !current.includes(run));

  // A pure deletion is stale if the lines it removed are back.
  const removed = runsOf(hunk, 'del');
  if (removed.length > 0) return removed.some((run) => current.includes(run));

  return false;
}

/**
 * Consecutive runs of one line kind, each joined. A single hunk often adds in
 * two or three places separated by context; testing all of its added lines as
 * one contiguous block would never match and would flag almost everything.
 */
function runsOf(hunk: DiffHunk, kind: 'add' | 'del'): string[] {
  const out: string[] = [];
  let run: string[] = [];
  for (const line of hunk.lines) {
    if (line.kind === kind) {
      run.push(line.text);
    } else if (run.length > 0) {
      out.push(run.join('\n'));
      run = [];
    }
  }
  if (run.length > 0) out.push(run.join('\n'));
  return out;
}

/** A created file has no patch — its content is the addition. */
function wholeFileHunk(content: string): DiffHunk[] {
  if (!content) return [];
  const rows = content.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return [{
    oldStart: 0, oldLines: 0, newStart: 1, newLines: rows.length,
    lines: rows.map((text, i) => ({ kind: 'add' as const, text, newLine: i + 1 })),
  }];
}

/** Claude Code's recorded patch, validated into our own shape. */
function normaliseHunks(raw: unknown): DiffHunk[] {
  if (!Array.isArray(raw)) return [];
  const out: DiffHunk[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const h = entry as Record<string, unknown>;
    if (!Array.isArray(h.lines)) continue;

    let oldLine = int(h.oldStart, 1);
    let newLine = int(h.newStart, 1);
    const lines: DiffLine[] = [];
    for (const row of h.lines) {
      if (typeof row !== 'string') continue;
      const text = row.slice(1);
      switch (row[0]) {
        case '+': lines.push({ kind: 'add', text, newLine: newLine++ }); break;
        case '-': lines.push({ kind: 'del', text, oldLine: oldLine++ }); break;
        // "\ No newline at end of file" — carry it as context so it renders.
        case '\\': lines.push({ kind: 'context', text: row }); break;
        default: lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
    out.push({
      oldStart: int(h.oldStart, 1), oldLines: int(h.oldLines, 0),
      newStart: int(h.newStart, 1), newLines: int(h.newLines, 0),
      lines,
    });
  }
  return out;
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Just the paths an agent wrote — no file reads, no diffing. The board needs
 * this for every live agent on every refresh, so it must stay cheap.
 */
export function touchedPaths(entries: Entry[]): string[] {
  const paths = new Set<string>();
  for (const msg of entries) {
    if (msg.type !== 'user') continue;
    const raw = msg.toolUseResult;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const p = (raw as { filePath?: unknown }).filePath;
    if (typeof p === 'string') paths.add(p);
  }
  return [...paths];
}

/**
 * A touched file as it is on disk now. Same ceiling as the staleness read —
 * anything past it is not something a browser should be asked to hold — and the
 * caller must have checked the path against `touchedPaths` first, which is what
 * keeps this from being an arbitrary-file read.
 */
export function readTouchedFile(path: string): string {
  if (!existsSync(path)) throw new Error('this file is no longer on disk');
  const size = statSync(path).size;
  if (size > MAX_DIFF_BYTES) {
    throw new Error(`file is ${(size / 1024 / 1024).toFixed(1)} MB — too large to copy`);
  }
  return readFileSync(path, 'utf8');
}
