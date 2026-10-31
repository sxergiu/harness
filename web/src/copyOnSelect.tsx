import { useEffect, useState, type RefObject } from 'react';
import type { Prefs } from '@harness/shared';
import { useApi } from './useHarness.js';

/** Where this browser kept the switch before the server did. */
const LEGACY_KEY = 'harness.copyOnSelect';

function legacy(): boolean | null {
  try {
    const v = localStorage.getItem(LEGACY_KEY);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

/**
 * The switch, kept by the server beside the theme — see `Prefs`. Off unless the
 * human turned it on: copying on select overwrites whatever was on the
 * clipboard, which nobody should discover by losing it.
 *
 * A choice this browser made before the server kept one is carried up the first
 * time the server says nobody has chosen, so the upgrade forgets nothing.
 */
export function useCopyOnSelect(prefs: Prefs | null): { on: boolean; toggle: () => void } {
  const { post } = useApi();
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (prefs === null) return;
    if (prefs.copyOnSelect !== null) {
      setOn(prefs.copyOnSelect);
      return;
    }
    const was = legacy();
    if (was === null) return;
    void post('/api/prefs', { copyOnSelect: was }).then(() => {
      try {
        localStorage.removeItem(LEGACY_KEY);
      } catch { /* carried up already; a stale copy here is never read again */ }
    }, () => {});
  }, [prefs, post]);

  const toggle = (): void => {
    const next = !on;
    // Set here as well as by the broadcast, so a server that did not answer
    // costs the choice its persistence, never the click.
    setOn(next);
    void post('/api/prefs', { copyOnSelect: next }).catch(() => {});
  };

  return { on, toggle };
}

interface Toast { x: number; y: number; error: string | null }

/**
 * Copies a selection made inside `root` when the mouse lets go of it, and
 * returns the label that says so, to be rendered anywhere inside `root`.
 *
 * Only a selection that CHANGED during the press is copied: clicking a button
 * leaves an earlier selection standing, and re-copying it on every click would
 * flash "copied" at actions that have nothing to do with the clipboard.
 * Both ends must lie inside `root`, so a drag that spills onto the board does
 * not carry board text with it, and a field's own selection is left alone —
 * selecting a word in the prompt box is how you replace it.
 */
export function useSelectionCopy(
  root: RefObject<HTMLElement | null>,
  on: boolean,
): React.ReactElement | null {
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    if (!on) return;
    // Compared by reading the selection at press and at release, never by
    // listening for `selectionchange`: that event is a queued task with no
    // ordering against input, and a double- or triple-click selects in one step
    // that its release routinely beats. Listeners run before the press moves
    // the selection, so `before` is always the selection the press started from.
    const mark = (): unknown[] => {
      const s = window.getSelection();
      return [s?.anchorNode, s?.anchorOffset, s?.focusNode, s?.focusOffset];
    };
    let before = mark();
    const onDown = (): void => { before = mark(); };
    const onUp = (e: MouseEvent): void => {
      if (mark().every((v, i) => v === before[i])) return;
      const el = root.current;
      const sel = window.getSelection();
      const text = sel?.toString() ?? '';
      if (!el || !sel || !text || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      const at = { x: e.clientX, y: e.clientY };
      void (async () => {
        try {
          await navigator.clipboard.writeText(text);
          setToast({ ...at, error: null });
        } catch (err) {
          // A failure has to say so in words: without the label, "did nothing"
          // and "copied" look the same.
          setToast({ ...at, error: (err as Error).message });
        }
      })();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
    };
  }, [root, on]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <span
      style={{ left: toast.x + 10, top: toast.y + 10 }}
      className={`pointer-events-none fixed z-50 max-w-xs truncate whitespace-nowrap rounded border border-neutral-800 bg-neutral-900 px-1 text-[11px] ${
        toast.error ? 'text-red-400' : 'text-emerald-400'
      }`}
    >
      {toast.error ?? 'copied'}
    </span>
  );
}
