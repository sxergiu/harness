import { spawn } from 'node:child_process';
import type { Herdr } from './herdr.js';

/**
 * How you find out anything happened, in both places you might be looking:
 * a native alert for when the browser is closed, and a Herdr toast for when
 * you are in the terminal.
 *
 * Deliberately never suppressed. An agent going blocked while its own view is
 * open still notifies — that was offered as an option and declined.
 */

export interface Notification {
  title: string;
  body: string;
  urgent?: boolean;
}

export function notify(herdr: Herdr, n: Notification): void {
  void herdr.toast(n.title, n.body, n.urgent ?? false).catch(() => {
    /* Herdr may be mid-reconnect; the native alert still lands */
  });

  if (process.platform === 'darwin') {
    const script =
      `display notification "${escapeAppleScript(n.body)}" ` +
      `with title "${escapeAppleScript(n.title)}"`;
    detached('osascript', ['-e', script]);

    detached('afplay', [
      n.urgent ? '/System/Library/Sounds/Sosumi.aiff' : '/System/Library/Sounds/Glass.aiff',
    ]);
  } else if (process.platform === 'linux') {
    // Never run — `os` in package.json kept npm from installing here at all
    // until recently, and this branch is the part of the platform work that no
    // measurement stands behind. Everything above it was watched working.
    //
    // argv, not a script: `escapeAppleScript` exists for AppleScript string
    // literals and would put visible backslashes in the notification.
    detached('notify-send', [
      ...(n.urgent ? ['-u', 'critical'] : []),
      n.title,
      n.body,
    ]);

    // A desktop that ships no player, or no freedesktop sound theme, costs the
    // sound and nothing else — which is why this is a separate spawn rather
    // than something the notification waits on.
    const sound = n.urgent ? 'dialog-warning' : 'complete';
    detached('canberra-gtk-play', ['-i', sound]);
  }

  // Windows deliberately has no branch. There is no dependency-free way to raise
  // a desktop toast from a plain process: the modern API wants a registered
  // AppId, and the usual PowerShell recipe needs a module that is not installed
  // by default — so anything written here would be code that looks like support
  // and mostly fails silently. The Herdr toast above is unconditional and is
  // what a Windows user gets; the README says so rather than leaving them to
  // discover it.
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function detached(cmd: string, args: string[]): void {
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.on('error', () => { /* a failed notification must never break the server */ });
    p.unref();
  } catch { /* ignore */ }
}
