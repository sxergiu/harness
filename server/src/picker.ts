import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * On macOS the dialog is an APPLET's, compiled into `~/.harness` on first use,
 * because nothing else a background process can do puts a window in front —
 * see `MAC_SCRIPT`. Measured on 26.4: it comes to the front, and killing the
 * applet takes the dialog with it. Its three answers are pinned by running the
 * applet with the dialog replaced by each outcome; a human's actual click has
 * not been watched. On Windows the shim compiles under PowerShell 5.1 and the
 * script runs up to the dialog; the dialog itself has not been opened. Those
 * answers are written from the tools' documented behaviour — zenity's exit 1 —
 * and `pickedFrom` is pinned in the tests because those tests are the only
 * evidence they have.
 */

const execFileAsync = promisify(execFile);

const TITLE = 'Choose the folder for this space';

/** What runs, and where its answer lands when not on stdout. */
interface Picker {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** A file the dialog writes its answer to, read in place of stdout. */
  result?: string;
}

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
  const controller = new AbortController();
  open = controller;
  // The applet's answer has nowhere else to go: it has no stdout of ours to
  // write to, and no argv reaches it. Its own directory, so the file cannot be
  // guessed at by another user of the machine.
  const scratch = platform === 'darwin' ? await mkdtemp(join(tmpdir(), 'harness-pick-')) : null;
  try {
    const { file, args, env, result } = await picker(platform, scratch);
    // No `windowsHide`, unlike `account.ts`: it sets SW_HIDE in STARTUPINFO,
    // which Windows may apply to a GUI process's first shown window — the
    // dialog. Expected rather than observed; the server always runs under a
    // console, so nothing should flash without it.
    const ran = await execFileAsync(file, args, { encoding: 'utf8', signal: controller.signal, env }).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (err: { code?: unknown; signal?: string | null; stdout?: string; stderr?: string }) => {
        if (err.code === 'ENOENT') throw new Error(`${file} is not available`);
        // A tab closed or a shutdown: nobody is waiting for an answer, and
        // logging it would put a false failure in the bug-report log. The
        // dialog is the killed process's own window, so it goes with it.
        if (controller.signal.aborted) return null;
        // Killed by a signal. Not `err` itself, whose message is the whole
        // command line — several KB of base64 on Windows.
        if (typeof err.code !== 'number') {
          throw new Error(`the folder dialog ended without answering (${err.signal ?? String(err.code)})`);
        }
        return { code: err.code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
      },
    );
    if (!ran) return null;
    if (result) ran.stdout = await readFile(result, 'utf8').catch(() => '');
    return pickedFrom(platform, ran);
  } finally {
    open = null;
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

const HARNESS = join(homedir(), '.harness');
const APPLET = join(HARNESS, 'harness-picker.app');
const APPLET_SOURCE = join(HARNESS, 'harness-picker.applescript');
const APPLET_BIN = join(APPLET, 'Contents', 'MacOS', 'applet');

/**
 * The applet, built when its source on disk is not this text or its binary is
 * gone — so an upgrade that changes the script rebuilds it, and nothing else
 * pays the compile (~0.5s). `osacompile` ships with macOS.
 */
async function macApplet(): Promise<string> {
  const [source, built] = await Promise.all([
    readFile(APPLET_SOURCE, 'utf8').catch(() => null),
    access(APPLET_BIN).then(() => true, () => false),
  ]);
  if (source === MAC_SCRIPT && built) return APPLET_BIN;
  await mkdir(HARNESS, { recursive: true });
  await writeFile(APPLET_SOURCE, MAC_SCRIPT);
  await execFileAsync('osacompile', ['-o', APPLET, APPLET_SOURCE]);
  return APPLET_BIN;
}

async function picker(platform: NodeJS.Platform, scratch: string | null): Promise<Picker> {
  if (platform === 'darwin') {
    const result = join(scratch ?? tmpdir(), 'answer');
    return {
      file: await macApplet(),
      args: [],
      env: { ...process.env, HARNESS_PICK_OUT: result },
      result,
    };
  }
  const [file, args] = pickerCommand(platform);
  return { file, args };
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
  if (platform === 'darwin') {
    // `stdout` is the applet's answer file: a status line, then the rest.
    if (code !== 0) throw new Error(stderr.trim() || `the folder dialog failed (exit ${code})`);
    const [status, ...rest] = stdout.split('\n');
    const body = rest.join('\n');
    if (status === 'ERR') throw new Error(body.trim() || 'the folder dialog failed');
    if (status === 'CANCEL') return null;
    // A cancel is written out, so an applet that wrote nothing is not one.
    if (status !== 'OK') throw new Error('the folder dialog ended without answering');
    stdout = body;
  }
  // zenity exits 1 for a cancel AND for a display it could not open.
  if (platform === 'linux' && code === 1 && !/cannot open display/i.test(stderr)) return null;
  if (code !== 0) throw new Error(stderr.trim() || `the folder dialog failed (exit ${code})`);
  const path = stdout.replace(/\r?\n$/, '');
  if (!path) return null;
  // osascript's POSIX path ends in `/`, which would reach the row and `basename`.
  return /^(\/|[A-Za-z]:\\)$/.test(path) ? path : path.replace(/[\\/]+$/, '');
}

/**
 * The macOS dialog, as an applet of our own.
 *
 * A background process cannot put a window in front of the browser, and every
 * way of asking was measured on 26.4 with Chrome in front: osascript's own
 * `activate`; hosting the dialog in System Events and activating that, which
 * this used to do and which once appeared to work; `set frontmost of process
 * "System Events"` and `AXRaise` on its window after the dialog was up; and
 * hosting it in Finder. All left the dialog open behind Chrome, with System
 * Events reporting `frontmost: false` — so the cockpit's button looked dead
 * while a dialog waited where nobody was looking. What does come to the
 * front is a real app that `activate`s itself before showing the dialog,
 * launched from this process by its binary. Launch Services is not what does
 * it: `open` alone left Chrome in front too.
 *
 * It is run by its binary rather than `open`, so `execFile`'s abort kills it
 * — and the dialog is its own window, so that closes it, measured — and so
 * `osacompile` is the only tool involved. But argv does NOT reach an applet
 * run that way (measured: `count of argv` was 0) and neither does our stdout
 * (`open for access` on `/dev/stdout` hangs it), so the answer file's path
 * travels in the environment and the answer travels in the file. Every
 * outcome is written out, the cancel included, so a file with nothing in it is
 * a failure and never a cancel. `on error` catches everything: an uncaught
 * error in an applet is a modal of its own, which `-128` would otherwise be.
 * The parameter is `s` because `text` is a class name here, and writing a
 * parameter called `text` wrote the class — `ctxt` — instead of the value.
 */
const MAC_SCRIPT = `on say(s)
  set f to open for access POSIX file (system attribute "HARNESS_PICK_OUT") with write permission
  write s to f as «class utf8»
  close access f
end say
try
  activate
  with timeout of 86400 seconds
    set p to POSIX path of (choose folder with prompt "${TITLE}")
  end timeout
  say("OK" & linefeed & p)
on error msg number n
  if n is -128 then
    say("CANCEL")
  else
    say("ERR" & linefeed & msg & " (" & n & ")")
  end if
end try
`;

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
