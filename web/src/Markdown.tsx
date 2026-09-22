import { CodeBlock } from './CodeBlock.js';
import { fileRef, type FileViewer } from './fileRef.js';

/**
 * Deliberately tiny markdown renderer — enough to make SPEC.md readable when
 * judging an interview's output, without pulling in a dependency. Handles
 * headings, bullets, inline code, bold, fenced code, and paragraphs. Anything
 * else renders as plain text rather than breaking.
 *
 * `viewer` makes a code span that names a file clickable. Optional, so prose
 * with nowhere to open a file into still renders — and threaded as a prop rather
 * than through a context, which this codebase has none of.
 */
export function Markdown(
  { source, viewer }: { source: string; viewer?: FileViewer },
): React.ReactElement {
  const blocks: React.ReactElement[] = [];
  const lines = source.split('\n');
  let list: string[] = [];
  let para: string[] = [];
  let fence: { lang: string; lines: string[] } | null = null;

  const flushList = (): void => {
    if (!list.length) return;
    blocks.push(
      <ul key={blocks.length} className="mb-3 ml-5 list-disc space-y-1">
        {list.map((item, i) => (
          <li key={i} className="text-sm text-neutral-300">{inline(item, viewer)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  const flushPara = (): void => {
    if (!para.length) return;
    blocks.push(
      <p key={blocks.length} className="mb-3 text-sm leading-relaxed text-neutral-300">
        {inline(para.join(' '), viewer)}
      </p>,
    );
    para = [];
  };
  const flush = (): void => { flushList(); flushPara(); };
  const flushFence = (): void => {
    if (!fence) return;
    blocks.push(
      <CodeBlock key={blocks.length} code={fence.lines.join('\n')} language={fence.lang || null} />,
    );
    fence = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Fences are settled before anything else: inside one, a leading `#` is a
    // comment and a leading `-` is a flag, not a heading and not a bullet.
    const mark = /^\s*```(.*)$/.exec(line);
    if (fence) {
      // `line` and not `line.trim()`: leading whitespace is content in code,
      // which is the one thing the paragraph path below is free to throw away.
      if (mark) flushFence();
      else fence.lines.push(line);
      continue;
    }
    if (mark) {
      flush();
      // The info string can carry more than a language: ```ts title=x
      fence = { lang: mark[1].trim().split(/\s+/)[0].toLowerCase(), lines: [] };
      continue;
    }

    if (!line.trim()) { flush(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1].length;
      const text = heading[2];
      const cls = level === 1
        ? 'mt-1 mb-3 text-xl font-semibold tracking-tight text-neutral-100'
        : level === 2
          ? 'mt-6 mb-2 border-b border-neutral-800 pb-1 text-sm font-semibold uppercase tracking-wider text-neutral-400'
          : 'mt-4 mb-1 font-medium text-neutral-100';
      blocks.push(<div key={blocks.length} className={cls}>{inline(text, viewer)}</div>);
      continue;
    }

    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); list.push(bullet[1]); continue; }

    flushList();
    para.push(line.trim());
  }
  flush();
  // An unterminated fence still renders as code rather than vanishing.
  flushFence();

  return <div>{blocks}</div>;
}

/** `code`, **bold**, and bare text. A code span naming a file opens it. */
function inline(text: string, viewer?: FileViewer): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('`')) {
      const body = token.slice(1, -1);
      const ref = viewer ? fileRef(body, viewer.cwd) : null;
      // A dotted underline rather than a colour of its own: the span is already
      // amber, and the amber band means something here (warnings, contention).
      // A `button` is valid inside the `p`, `li` and heading `div` above it.
      out.push(
        ref
          ? (
            <button
              key={out.length}
              onClick={() => viewer?.open(ref)}
              title={`Open ${ref}`}
              className="rounded bg-neutral-800 px-1 py-0.5 text-[12px] text-amber-200 underline decoration-dotted underline-offset-2 hover:text-amber-100"
            >
              {body}
            </button>
          )
          : (
            <code key={out.length} className="rounded bg-neutral-800 px-1 py-0.5 text-[12px] text-amber-200">
              {body}
            </code>
          ),
      );
    } else {
      // Recursed, because **`path`** is how a file usually gets named in a
      // summary and the bold branch wins that token whole — so without this the
      // backticks render literally and the path inside is never offered as a
      // link. Terminates: the bold body cannot contain a `*`, so the inner pass
      // finds no bold of its own.
      out.push(
        <strong key={out.length} className="font-semibold text-neutral-100">
          {inline(token.slice(2, -2), viewer)}
        </strong>,
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
