import { useEffect, useRef, useState } from 'react';
import type { Prefs } from '@harness/shared';
import { useApi } from './useHarness.js';

/**
 * Which way round the page is. Dark is the default and carries NO class — the
 * whole light theme is one `:root.light` block in index.css that overrides the
 * Tailwind neutral and accent ramps, so this module's entire job is keeping
 * that one class in step with the OS, the server's pref and the toggle.
 *
 * That is why nothing here knows a single colour: the ramp is the token layer,
 * so a theme is a class and not a palette threaded through the tree.
 */
export type Theme = 'dark' | 'light';

/**
 * A CACHE of the server's pref (`Prefs`), kept only because `index.html` has to
 * decide before first paint and cannot wait on a socket. The server's answer
 * overwrites it on every `hello`.
 */
const THEME_KEY = 'harness.theme';

/**
 * Null until the human actually picks one, which is the difference that matters:
 * an unset preference keeps following the OS for the life of the page, and a set
 * one wins forever. Anything unrecognised in storage reads as unset rather than
 * as dark, so a half-written value returns to following the OS instead of
 * pinning the page to a theme nobody chose.
 */
function stored(): Theme | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // Reading can throw outright where site data is blocked, and that reads as
    // unset too: following the OS beats taking the page down over a preference.
    return null;
  }
}

function cache(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Unwritable storage costs the next load a flash of the other theme, never the click.
  }
}

const preferred = (): Theme =>
  window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

/**
 * The theme, and the one way to change it. `index.html` has already put the
 * class on before first paint — this hook exists to keep the class in step with
 * an OS that changes under us, and to give the toggle somewhere to write.
 */
export function useTheme(prefs: Prefs | null): { theme: Theme; toggle: () => void } {
  const { post } = useApi();
  /**
   * Read back off the class rather than resolving the rule a second time:
   * `index.html` has already decided and written it before first paint, so this
   * cannot disagree with what is on screen.
   */
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.classList.contains('light') ? 'light' : 'dark'),
  );

  /** The server's answer, which storage only caches and may be unable to hold. */
  const chosen = useRef<Theme | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: light)');
    // Re-read rather than closing over it: the human may have picked a theme
    // since this listener was attached, and their choice outranks the OS.
    const follow = (): void => {
      if (!chosen.current && !stored()) setTheme(preferred());
    };
    query.addEventListener('change', follow);
    return () => query.removeEventListener('change', follow);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('light', theme === 'light');
  }, [theme]);

  // Server unset with a cached choice is one made before the server kept it,
  // and is carried up rather than forgotten.
  useEffect(() => {
    if (prefs === null) return;
    if (prefs.theme === null) {
      const was = stored();
      if (was) void post('/api/prefs', { theme: was }).catch(() => {});
      return;
    }
    chosen.current = prefs.theme;
    cache(prefs.theme);
    setTheme(prefs.theme);
  }, [prefs, post]);

  const toggle = (): void => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    chosen.current = next;
    cache(next);
    setTheme(next);
    void post('/api/prefs', { theme: next }).catch(() => {});
  };

  return { theme, toggle };
}
