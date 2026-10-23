import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * The OS folder dialog, for a space's directory. Opened by THIS process because
 * a page can never learn an absolute path — a browser's own picker hands over
 * names relative to the folder and nothing above it — and this process is on
 * the same desktop as the human by construction (it binds 127.0.0.1).
 *
 * No timeout: a human is answering it. What bounds it instead is `cancelPick`,
 * which `shutdown` calls because `app.close()` waits on requests in flight, and
 * a dialog left open would otherwise hold the process up forever.
 *
 * On macOS the dialog has been opened from a background process and seen to
 * come to the front, and seen to outlive a killed osascript; its answers have
 * not been watched. On Windows the shim compiles under PowerShell 5.1 and the
 * script runs up to the dialog; the dialog itself has not been opened. The
 * answers are written from the tools' documented behaviour — osascript's
 * `-128` cancel, zenity's exit 1 — and `pickedFrom` is pinned in the tests
 * because those tests are the only evidence they have.
 */

const execFileAsync = promisify(execFile);

const TITLE = 'Choose the folder for this space';

/** The dialog's process while one is on screen: one at a time, and killable. */
let open: AbortController | null = null;

export const picking = (): boolean => open !== null;

export function cancelPick(): void {
  open?.abort();
}

/** The folder the human chose, or null for a cancel. Anything else throws. */
export async function pickDir(): Promise<string | null> {
  const platform = process.platform;
  if (platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw new Error('no display to open a folder dialog on');
  }
  const [file, args] = pickerCommand(platform);
  const controller = new AbortController();
  open = controller;
  try {
    // No `windowsHide`, unlike `account.ts`: it sets SW_HIDE in STARTUPINFO,
    // which Windows may apply to a GUI process's first shown window — the
    // dialog. Expected rather than observed; the server always runs under a
    // console, so nothing should flash without it.
    const ran = await execFileAsync(file, args, { encoding: 'utf8', signal: controller.signal }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (err: { code?: unknown; signal?: string | null; stdout?: string; stderr?: string }) => {
        if (err.code === 'ENOENT') throw new Error(`${file} is not available`);
        // A tab closed or a shutdown: nobody is waiting for an answer, and
        // logging it would put a false failure in the bug-report log.
        if (controller.signal.aborted) {
          // The dialog lives in System Events, so killing osascript leaves it on
          // screen (measured). Quitting it is the only close there is without an
          // accessibility grant, and it relaunches when next asked for.
          if (platform === 'darwin') execFile('osascript', ['-e', 'quit app "System Events"'], () => {});
          return null;
        }
        // Killed by a signal. Not `err` itself, whose message is the whole
        // command line — several KB of base64 on Windows.
        if (typeof err.code !== 'number') {
          throw new Error(`the folder dialog ended without answering (${err.signal ?? String(err.code)})`);
        }
        return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      },
    );
    return ran && pickedFrom(platform, ran);
  } finally {
    open = null;
  }
}

function pickerCommand(platform: NodeJS.Platform): [string, string[]] {
  switch (platform) {
    case 'win32':
      // Encoded rather than quoted: the script is ours and literal, but a
      // here-string full of quotes through PowerShell 5.1's argument handling
      // is invariant 11's hazard all over again.
      return ['powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA',
        '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64'),
      ]];
    case 'darwin':
      // Hosted by System Events, because osascript's own dialog opens BEHIND the
      // browser: measured on macOS 26, a server cannot bring itself forward,
      // `activate` or not, while System Events' `activate` does. The timeout is
      // because a reply from another app otherwise gives up after 2 minutes,
      // leaving the dialog up with nobody waiting on it.
      return ['osascript', [
        '-e', 'with timeout of 86400 seconds',
        '-e', 'tell application "System Events"',
        '-e', 'activate',
        '-e', `POSIX path of (choose folder with prompt "${TITLE}")`,
        '-e', 'end tell',
        '-e', 'end timeout',
      ]];
    default:
      return ['zenity', ['--file-selection', '--directory', `--title=${TITLE}`]];
  }
}

/**
 * A cancel and a failure, told apart. Misreading a failure as a cancel is a
 * click that does nothing and says nothing, which is why this is tested.
 *
 * zenity exits 1 for Cancel and for closing the window alike, and routinely
 * prints a `Gtk-Message` on stderr while doing it — so stderr says nothing there.
 */
export function pickedFrom(
  platform: NodeJS.Platform,
  { code, stdout, stderr }: { code: number; stdout: string; stderr: string },
): string | null {
  if (platform === 'darwin' && code === 1 && /\(-128\)/.test(stderr)) return null;
  // zenity exits 1 for a cancel AND for a display it could not open.
  if (platform === 'linux' && code === 1 && !/cannot open display/i.test(stderr)) return null;
  if (code !== 0) throw new Error(stderr.trim() || `the folder dialog failed (exit ${code})`);
  const path = stdout.replace(/\r?\n$/, '');
  if (!path) return null;
  // osascript's POSIX path ends in `/`, which would reach the row and `basename`.
  return /^(\/|[A-Za-z]:\\)$/.test(path) ? path : path.replace(/[\\/]+$/, '');
}

/**
 * The Vista-style folder dialog, through `IFileOpenDialog` with
 * FOS_PICKFOLDERS — WinForms' `FolderBrowserDialog` on .NET Framework is the
 * old tree, with no address bar to paste a path into.
 *
 * Exit 0 with a path is a pick, exit 0 with nothing is a cancel, exit 1 with
 * stderr is a failure. `$ProgressPreference` is load-bearing: without it
 * `Add-Type` writes a CLIXML "Preparing modules for first use" block to stderr,
 * which would become the error message. Stdout is UTF-8 without a BOM, so a
 * path with diacritics comes back byte-identical (measured).
 *
 * The owner is a never-shown TOPMOST form, meant to keep the dialog from being
 * buried under the browser — expected, not yet observed — and Windows'
 * foreground lock may still leave it needing a click.
 * Unindented because the `'@` closing the here-string must sit at column 0.
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
try {
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public static class HarnessFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] private class FileOpenDialog {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  const uint FOS_PICKFOLDERS = 0x20, FOS_FORCEFILESYSTEM = 0x40, FOS_PATHMUSTEXIST = 0x800;
  const uint SIGDN_FILESYSPATH = 0x80058000;
  const int ERROR_CANCELLED = unchecked((int)0x800704C7);
  public static string Pick(string title) {
    var dialog = (IFileDialog)new FileOpenDialog();
    uint fos; dialog.GetOptions(out fos);
    dialog.SetOptions(fos | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
    dialog.SetTitle(title);
    using (var owner = new Form { TopMost = true, ShowInTaskbar = false }) {
      int hr = dialog.Show(owner.Handle);
      if (hr == ERROR_CANCELLED) return null;
      Marshal.ThrowExceptionForHR(hr);
    }
    IShellItem item; dialog.GetResult(out item);
    string path; item.GetDisplayName(SIGDN_FILESYSPATH, out path);
    return path;
  }
}
'@
  $p = [HarnessFolderPicker]::Pick('${TITLE}')
  if ($p) { [Console]::Out.Write($p) }
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
`;
