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
    // Kept, but unsupported: `os` in package.json is darwin-only, so npm refuses
    // to install here and this is reachable only from a git checkout. It has
    // never been run, which is exactly why the platform claim was dropped —
    // everything else in this file was watched working.
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
