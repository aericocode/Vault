/**
 * Where the Stage window is (Windows): a small helper that watches mpv's
 * window and says when its rectangle changes, so Stage opens next time where
 * it was left (PLAYLISTS_SPEC, Stage decision 4). mpv can set its window's
 * size and spot (--geometry, and the geometry property at run time) but has
 * no property that says where the window is now.
 *
 * The helper is PowerShell running a few lines of C# (Add-Type, like the file
 * pickers), started once mpv's window exists. It owns no window of its own,
 * so it can never show as "not responding". It checks that the handle it is
 * given belongs to the mpv process Vault started, then polls the rectangle
 * twice a second and prints a line only when something changed:
 *
 *   bounds <x> <y> <w> <h> <max 0|1> <min 0|1> <work x> <y> <w> <h>
 *   styles <style hex> <exstyle hex>       (once, for diagnostics)
 *
 * It ends when Vault's process ends, when mpv's window goes, or when its
 * stdin closes. Without it (it could not start, or not Windows) Stage works
 * the same; it just does not remember where the window was.
 *
 * Inputs come only through the environment (numbers Vault checked), never
 * spliced into the script text. The script goes in as -EncodedCommand, so no
 * file is written.
 */

const { spawn } = require('child_process');

const SCRIPT = `
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class VaultStageWindow {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);

  static void Say(string s) { try { Console.Out.WriteLine(s); Console.Out.Flush(); } catch { } }

  public static int Run(long hwnd, uint mpvPid, uint parentPid) {
    // Screen pixels, as mpv's --geometry takes them.
    try { if (SetThreadDpiAwarenessContext((IntPtr)(-4)) == IntPtr.Zero) SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { }
    IntPtr h = (IntPtr)hwnd;
    uint owner;
    GetWindowThreadProcessId(h, out owner);
    if (!IsWindow(h) || owner != mpvPid) { Say("error not-the-stage-window"); return 2; }
    IntPtr parent = OpenProcess(0x00100000, false, parentPid);   // SYNCHRONIZE
    if (parent == IntPtr.Zero) { Say("error no-parent"); return 3; }
    var stdin = new Thread(() => { try { while (Console.In.ReadLine() != null) { } } catch { } Environment.Exit(0); });
    stdin.IsBackground = true;
    stdin.Start();
    Say(string.Format("styles {0:X8} {1:X8}", GetWindowLongPtr(h, -16).ToInt64(), GetWindowLongPtr(h, -20).ToInt64()));
    string last = "";
    while (true) {
      if (WaitForSingleObject(parent, 500) == 0) return 0;          // Vault ended
      if (!IsWindow(h)) return 0;                                     // mpv's window went
      RECT r; if (!GetWindowRect(h, out r)) continue;
      var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
      GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
      string line = string.Format("bounds {0} {1} {2} {3} {4} {5} {6} {7} {8} {9}",
        r.L, r.T, r.R - r.L, r.B - r.T, IsZoomed(h) ? 1 : 0, IsIconic(h) ? 1 : 0,
        mi.rcWork.L, mi.rcWork.T, mi.rcWork.R - mi.rcWork.L, mi.rcWork.B - mi.rcWork.T);
      if (line != last) { last = line; Say(line); }
    }
  }
}
'@
Add-Type -TypeDefinition $src
exit [VaultStageWindow]::Run([long]$env:VAULT_STAGE_HWND, [uint32]$env:VAULT_STAGE_MPV_PID, [uint32]$env:VAULT_STAGE_PARENT)
`;

const MAX_LINE = 4096;

/** One line from the helper, or null. */
function parseLine(line) {
  const parts = String(line || '').trim().split(/\s+/);
  if (parts[0] === 'bounds') {
    const n = parts.slice(1).map(Number);
    if (n.length !== 10 || n.some(x => !Number.isInteger(x))) return null;
    return { type: 'bounds', win: { x: n[0], y: n[1], w: n[2], h: n[3] }, max: n[4] === 1, min: n[5] === 1, work: { x: n[6], y: n[7], w: n[8], h: n[9] } };
  }
  if (parts[0] === 'styles' && /^[0-9A-F]{8}$/i.test(parts[1] || '') && /^[0-9A-F]{8}$/i.test(parts[2] || '')) {
    return { type: 'styles', style: parseInt(parts[1], 16), ex: parseInt(parts[2], 16) };
  }
  if (parts[0] === 'error') return { type: 'error', message: parts.slice(1).join(' ').slice(0, 200) };
  return null;
}

/**
 * Start watching. Returns { stop() } (or null where there is nothing to run).
 * @param {object} o
 * @param {number} o.hwnd     mpv's window-id property
 * @param {number} o.mpvPid   the mpv process Vault started
 * @param {(ev: object) => void} o.onEvent
 */
function watchWindow({ hwnd, mpvPid, onEvent = () => {}, platform = process.platform, spawnFn = spawn } = {}) {
  if (platform !== 'win32') return null;
  if (!Number.isSafeInteger(hwnd) || hwnd <= 0 || !Number.isInteger(mpvPid) || mpvPid <= 0) return null;
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  let child;
  try {
    child = spawnFn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, VAULT_STAGE_HWND: String(hwnd), VAULT_STAGE_MPV_PID: String(mpvPid), VAULT_STAGE_PARENT: String(process.pid) },
    });
  } catch { return null; }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    if (buf.length > MAX_LINE && buf.indexOf('\n') === -1) { buf = ''; try { child.kill(); } catch {} return; }
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const ev = parseLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (ev) { try { onEvent(ev); } catch {} }
    }
  });
  child.on('error', () => {});
  if (child.stdin) child.stdin.on('error', () => {});
  return {
    pid: child.pid,
    stop() {
      try { child.stdin.end(); } catch {}
      const t = setTimeout(() => { try { child.kill(); } catch {} }, 1500);
      if (t.unref) t.unref();
    },
  };
}

module.exports = { watchWindow, parseLine, SCRIPT };
