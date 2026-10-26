/**
 * The Stage host: a small PowerShell + WinForms helper that shows the Stage
 * page in a frameless WebView2 window (PLAYLISTS_SPEC 5, spike of 2026-10-25:
 * .notes/stage-spike/wv2host.ps1). Run by lib/stage/host.js, which writes this
 * script to a temp file (like the file pickers in server/index.js) and talks
 * to it over stdin / stdout, one line per message.
 *
 * Inputs come in the environment, never in the script text:
 *   VAULT_STAGE_URL      the page (http://127.0.0.1:<port>/stage)
 *   VAULT_STAGE_UDD      WebView2's user data folder (under Vault's data folder)
 *   VAULT_STAGE_SDK      the folder with the three SDK files (checked by lib/stage/sdk.js)
 *   VAULT_STAGE_PINS     their SHA-256s, "name=hash;...": checked again here before loading
 *   VAULT_STAGE_LAUNCH   a fresh folder for this launch, where the checked bytes are written
 *   VAULT_STAGE_TITLE    the window name (Settings › Stage, "Vault Stage")
 *   VAULT_STAGE_BOUNDS   "x,y,w,h,max" from last time, or empty
 *   VAULT_STAGE_CLIENT   "w,h": open with exactly this picture size, or empty
 *   VAULT_STAGE_PARENT   Vault's process id: the window closes when Vault goes
 *   VAULT_STAGE_ARGS     extra browser arguments
 *   VAULT_STAGE_MUTE     "1": no sound at all (test servers)
 *   VAULT_STAGE_TEST_MINIMISED  "1": open minimised (checks of the restore on open)
 *
 * stdout: "ready <hwnd>", "runtime <version>", "bounds <win x y w h>
 *   <client x y w h> <work x y w h> <max 0|1>", "closing user|parent|cmd",
 *   "error <text>".
 * stdin:  "front", "rect x y w h", "client w h", "title <text>", "close".
 *
 * The window: all client area (WM_NCCALCSIZE drops the caption and the
 * border), so what Windows Graphics Capture records is exactly the window and
 * a size preset is exactly the picture Discord gets. Resizable from a thin
 * black edge the web view leaves round the picture (WM_NCHITTEST), square
 * corners, no border line, black. When maximised its picture is exactly the
 * monitor's work area, so nothing sits under the taskbar. Restoring puts back
 * the size it had before (WinForms on its own adds a caption's height).
 */

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# The SDK files, checked here against the pins right before use (Vault checked
# them too, but a file can change between that check and this load). Each one
# is read once; those exact bytes are hashed, the two managed assemblies are
# loaded from them, and they are written to a fresh folder for this launch
# only (under Vault's data folder) for the compiler and the native loader.
# WebView2Loader.dll is hashed once more right before it is loaded. Any
# mismatch: nothing is loaded, the window never opens.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
public static class VaultStageSdk {
  static Assembly core, winforms;
  public static string Hash(byte[] b) { using (var s = SHA256.Create()) return BitConverter.ToString(s.ComputeHash(b)).Replace("-", ""); }
  public static string Pin(string pins, string name) {
    foreach (var p in (pins ?? "").Split(';')) { var kv = p.Split('='); if (kv.Length == 2 && kv[0] == name) return kv[1].Trim().ToUpperInvariant(); }
    return null;
  }
  /** "" when all is well, else what is wrong. */
  public static string Prepare(string sdk, string dir, string pins) {
    string[] names = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };
    try { Directory.CreateDirectory(dir); } catch (Exception x) { return "the Stage window files could not be prepared: " + x.Message; }
    foreach (var name in names) {
      string want = Pin(pins, name);
      if (want == null) return "no pin for " + name;
      byte[] bytes;
      try { bytes = File.ReadAllBytes(Path.Combine(sdk, name)); } catch { return name + " is missing"; }
      if (Hash(bytes) != want) return name + " is not the expected file";
      File.WriteAllBytes(Path.Combine(dir, name), bytes);
      if (name == names[0]) core = Assembly.Load(bytes);
      else if (name == names[1]) winforms = Assembly.Load(bytes);
    }
    AppDomain.CurrentDomain.AssemblyResolve += (s, e) => {
      string n = new AssemblyName(e.Name).Name;
      if (core != null && n == core.GetName().Name) return core;
      if (winforms != null && n == winforms.GetName().Name) return winforms;
      return null;
    };
    return "";
  }
  /** The loader copy for this launch, still the pinned file, right before it is loaded. */
  public static bool LoaderOk(string dir, string pins) {
    try { return Hash(File.ReadAllBytes(Path.Combine(dir, "WebView2Loader.dll"))) == Pin(pins, "WebView2Loader.dll"); } catch { return false; }
  }
}
'@
$launch = $env:VAULT_STAGE_LAUNCH
$bad = [VaultStageSdk]::Prepare($env:VAULT_STAGE_SDK, $launch, $env:VAULT_STAGE_PINS)
if ($bad) { [Console]::Out.WriteLine('error ' + $bad); [Console]::Out.Flush(); exit 3 }
$refs = @('System.Windows.Forms', 'System.Drawing', (Join-Path $launch 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $launch 'Microsoft.Web.WebView2.WinForms.dll'))
Add-Type -ReferencedAssemblies $refs -TypeDefinition @'
using System;
using System.Drawing;
using System.Threading;
using System.Diagnostics;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public class VaultStageForm : Form {
  /**
   * The loader copy for this launch, checked right before it is loaded
   * (VaultStageSdk lives in another assembly). The file is opened with read
   * sharing only and hashed through that handle; the handle stays open until
   * the web view has loaded the DLL, so nobody can change or replace the file
   * in between. null: not the pinned file (or not there).
   */
  static System.IO.FileStream OpenVerifiedLoader(string dir, string pins) {
    System.IO.FileStream f = null;
    try {
      string want = null;
      foreach (var p in (pins ?? "").Split(';')) { var kv = p.Split('='); if (kv.Length == 2 && kv[0] == "WebView2Loader.dll") want = kv[1].Trim().ToUpperInvariant(); }
      if (want == null) return null;
      f = new System.IO.FileStream(System.IO.Path.Combine(dir, "WebView2Loader.dll"), System.IO.FileMode.Open, System.IO.FileAccess.Read, System.IO.FileShare.Read);
      string got;
      using (var sha = System.Security.Cryptography.SHA256.Create()) got = BitConverter.ToString(sha.ComputeHash(f)).Replace("-", "");
      if (got == want) return f;
    } catch { }
    if (f != null) f.Dispose();
    return null;
  }
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int attr, ref int value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT value, int size);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MINMAXINFO { public POINT reserved, maxSize, maxPos, minTrack, maxTrack; }

  const int EDGE = 4;                 // px (at 96 dpi) round the picture the web view leaves for resizing
  public WebView2 web;
  readonly string url, udd, args, origin;
  readonly bool mute;
  Rectangle normal = Rectangle.Empty;   // the size and spot to restore to
  FormWindowState lastState = FormWindowState.Normal;
  bool restoring;
  string closeReason = "user";
  readonly System.Windows.Forms.Timer boundsTimer = new System.Windows.Forms.Timer();
  readonly object outLock = new object();

  public void Say(string line) { lock (outLock) { try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { } } }

  public VaultStageForm(string url, string udd, string args, string title, bool mute) {
    this.url = url; this.udd = udd; this.args = args; this.mute = mute;
    var u = new Uri(url); origin = u.Scheme + "://" + u.Authority;
    Text = string.IsNullOrEmpty(title) ? "Vault Stage" : title;
    BackColor = Color.Black;
    FormBorderStyle = FormBorderStyle.Sizable;
    StartPosition = FormStartPosition.Manual;
    ShowIcon = true;
    MinimumSize = new Size(160, 90);
    web = new WebView2();
    web.DefaultBackgroundColor = Color.Black;
    web.CreationProperties = new CoreWebView2CreationProperties { UserDataFolder = udd, AdditionalBrowserArguments = args };
    Controls.Add(web);
    PlaceWeb();
    boundsTimer.Interval = 400;
    boundsTimer.Tick += (s, e) => { boundsTimer.Stop(); ReportBounds(); };
    Resize += (s, e) => OnSized();
    Move += (s, e) => { if (WindowState == FormWindowState.Normal && !restoring) normal = Bounds; boundsTimer.Stop(); boundsTimer.Start(); };
    ResizeEnd += (s, e) => { if (WindowState == FormWindowState.Normal) normal = Bounds; ReportBounds(); };
    FormClosing += (s, e) => { ReportBounds(); Say("closing " + closeReason); };
    web.CoreWebView2InitializationCompleted += (s, e) => {
      if (!e.IsSuccess) { Say("error " + (e.InitializationException == null ? "WebView2 did not start" : e.InitializationException.Message.Replace("\r", " ").Replace("\n", " "))); closeReason = "error"; Close(); return; }
      var cw = web.CoreWebView2;
      Say("runtime " + cw.Environment.BrowserVersionString);
      try { cw.Settings.IsNonClientRegionSupportEnabled = true; } catch { }
      cw.Settings.AreDefaultContextMenusEnabled = false;
      cw.Settings.AreDevToolsEnabled = Environment.GetEnvironmentVariable("VAULT_STAGE_DEVTOOLS") == "1";
      cw.Settings.IsStatusBarEnabled = false;
      cw.Settings.IsZoomControlEnabled = false;
      cw.Settings.AreDefaultScriptDialogsEnabled = false;
      try { cw.Settings.IsPasswordAutosaveEnabled = false; cw.Settings.IsGeneralAutofillEnabled = false; } catch { }
      if (this.mute) { try { cw.IsMuted = true; } catch { } }
      // Only Vault's own pages, never a new window.
      cw.NewWindowRequested += (s2, e2) => { e2.Handled = true; };
      cw.NavigationStarting += (s2, e2) => { if (!e2.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase)) e2.Cancel = true; };
      cw.DocumentTitleChanged += (s2, e2) => { var t = cw.DocumentTitle; if (!string.IsNullOrEmpty(t) && !t.StartsWith("http")) Text = t; };
      cw.WebMessageReceived += (s2, e2) => {
        string m = null; try { m = e2.TryGetWebMessageAsString(); } catch { }
        if (m == "drag" && WindowState != FormWindowState.Maximized) { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); }
        else if (m == "max") ToggleMax();
      };
      cw.Navigate(url);
    };
    Load += async (s, e) => {
      string launchDir = Environment.GetEnvironmentVariable("VAULT_STAGE_LAUNCH");
      var loaderLock = OpenVerifiedLoader(launchDir, Environment.GetEnvironmentVariable("VAULT_STAGE_PINS"));
      if (loaderLock == null) {
        Say("error WebView2Loader.dll is not the expected file"); closeReason = "error"; Close(); return;
      }
      try {
        CoreWebView2Environment.SetLoaderDllFolderPath(launchDir);
        await web.EnsureCoreWebView2Async();
      } catch (Exception x) { Say("error " + x.Message.Replace("\r", " ").Replace("\n", " ")); closeReason = "error"; Close(); }
      finally { loaderLock.Dispose(); }   // loaded (or failed): held no longer than needed
    };
  }

  void PlaceWeb() {
    int e = WindowState == FormWindowState.Maximized ? 0 : Edge();
    web.SetBounds(e, e, Math.Max(1, ClientSize.Width - 2 * e), Math.Max(1, ClientSize.Height - 2 * e));
  }

  void OnSized() {
    PlaceWeb();
    if (lastState == FormWindowState.Maximized && WindowState == FormWindowState.Normal && normal != Rectangle.Empty) {
      // Back from maximised: the size it had, not the size WinForms works out.
      restoring = true;
      var r = normal;
      BeginInvoke((Action)(() => { Bounds = r; restoring = false; PlaceWeb(); ReportBounds(); }));
    } else if (WindowState == FormWindowState.Normal && !restoring) {
      normal = Bounds;
    }
    if (WindowState != lastState) { lastState = WindowState; ReportBounds(); }
    else { boundsTimer.Stop(); boundsTimer.Start(); }
  }

  public void ToggleMax() {
    WindowState = WindowState == FormWindowState.Maximized ? FormWindowState.Normal : FormWindowState.Maximized;
  }

  RECT Work() {
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(Handle, 2), ref mi);
    return mi.rcWork;
  }

  public void ReportBounds() {
    if (!IsHandleCreated || WindowState == FormWindowState.Minimized) return;
    RECT w; GetWindowRect(Handle, out w);
    var c = RectangleToScreen(ClientRectangle);
    var k = Work();
    var n = normal == Rectangle.Empty ? new Rectangle(w.L, w.T, w.R - w.L, w.B - w.T) : normal;
    bool max = WindowState == FormWindowState.Maximized;
    // While maximised the size to come back to is the one before.
    Say(string.Format("bounds {0} {1} {2} {3} {4} {5} {6} {7} {8} {9} {10} {11} {12} {13} {14} {15} {16}",
      w.L, w.T, w.R - w.L, w.B - w.T, c.X, c.Y, c.Width, c.Height, k.L, k.T, k.R - k.L, k.B - k.T, max ? 1 : 0,
      n.X, n.Y, n.Width, n.Height));
  }

  /** The picture exactly w x h: the window is that plus its (invisible) frame. */
  public void SetClient(int w, int h) {
    if (WindowState != FormWindowState.Normal) { WindowState = FormWindowState.Normal; if (normal != Rectangle.Empty) Bounds = normal; }
    RECT r; GetWindowRect(Handle, out r);
    var c = RectangleToScreen(ClientRectangle);
    int fl = c.X - r.L, ft = c.Y - r.T, fr = r.R - (c.X + c.Width), fb = r.B - (c.Y + c.Height);
    var k = Work();
    int cx = Math.Max(k.L, Math.Min(c.X, k.R - w)), cy = Math.Max(k.T, Math.Min(c.Y, k.B - h));
    SetRect(cx - fl, cy - ft, w + fl + fr, h + ft + fb);
  }

  public void SetRect(int x, int y, int w, int h) {
    // Maximised first: restoring lands on this rectangle (OnSized puts normal back).
    normal = new Rectangle(x, y, w, h);
    if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
    SetWindowPos(Handle, IntPtr.Zero, x, y, w, h, 0x0014);   // SWP_NOZORDER | SWP_NOACTIVATE
    normal = Bounds;
    PlaceWeb();
    ReportBounds();
  }

  public void Front() {
    if (IsIconic(Handle)) ShowWindow(Handle, 9);   // SW_RESTORE
    TopMost = true; TopMost = false;
    BringWindowToTop(Handle);
    SetForegroundWindow(Handle);
  }

  /**
   * Once, as the window opens: it ends up restored, on a monitor, in front.
   * A process started minimised (or hidden: Vault starts the helper with no
   * console window) can hand that state to its first window, and nothing
   * else would restore it. Raised over the others once (TopMost on and off),
   * never again.
   */
  public void EnsureShown() {
    if (IsIconic(Handle)) ShowWindow(Handle, 9);   // SW_RESTORE
    Rectangle b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
    bool seen = false;
    foreach (Screen s in Screen.AllScreens) {
      Rectangle i = Rectangle.Intersect(b, s.WorkingArea);
      if (i.Width >= 64 && i.Height >= 64) { seen = true; break; }
    }
    if (!seen) {
      Rectangle wa = Screen.PrimaryScreen.WorkingArea;
      int w = Math.Min(Math.Max(b.Width, 320), wa.Width), h = Math.Min(Math.Max(b.Height, 180), wa.Height);
      if (WindowState != FormWindowState.Normal) WindowState = FormWindowState.Normal;
      SetWindowPos(Handle, IntPtr.Zero, wa.X + (wa.Width - w) / 2, wa.Y + (wa.Height - h) / 2, w, h, 0x0014);
      normal = Bounds;
    }
    TopMost = true; TopMost = false;
  }

  public void CloseFor(string why) { closeReason = why; Close(); }

  /** One command per line on stdin; end of input (Vault gone) closes. And Vault's process exiting closes. */
  public void StartWatchers(int parentPid) {
    var reader = new Thread(() => {
      while (true) {
        string line = null;
        try { line = Console.In.ReadLine(); } catch { }
        if (line == null) { Post(() => CloseFor("parent")); return; }
        var p = line.Split(new[] { ' ' }, 2);
        string arg = p.Length > 1 ? p[1] : "";
        var q = arg.Split(' ');
        int a, b, c, d;
        switch (p[0]) {
          case "front": Post(Front); break;
          case "close": Post(() => CloseFor("cmd")); break;
          case "title": Post(() => { Text = arg; }); break;
          case "client":
            if (q.Length == 2 && int.TryParse(q[0], out a) && int.TryParse(q[1], out b)) Post(() => SetClient(a, b));
            break;
          case "rect":
            if (q.Length == 4 && int.TryParse(q[0], out a) && int.TryParse(q[1], out b) && int.TryParse(q[2], out c) && int.TryParse(q[3], out d)) Post(() => SetRect(a, b, c, d));
            break;
        }
      }
    });
    reader.IsBackground = true;
    reader.Start();
    if (parentPid > 0) {
      var watch = new Thread(() => {
        try { Process.GetProcessById(parentPid).WaitForExit(); } catch { }
        Post(() => CloseFor("parent"));
      });
      watch.IsBackground = true;
      watch.Start();
    }
  }

  void Post(Action a) {
    try { if (IsHandleCreated && !IsDisposed) BeginInvoke(a); else if (!IsDisposed) { Load += (s, e) => a(); } } catch { }
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int square = 1;   // DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_DONOTROUND
    try { DwmSetWindowAttribute(Handle, 33, ref square, 4); } catch { }
    int noBorder = unchecked((int)0xFFFFFFFE);   // DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE: no 1 px line round the picture
    try { DwmSetWindowAttribute(Handle, 34, ref noBorder, 4); } catch { }
  }

  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);

  /** The resize edge inside the window, in px for its DPI. */
  int Edge() {
    uint dpi = 96;
    try { if (IsHandleCreated) dpi = GetDpiForWindow(Handle); } catch { }
    return Math.Max(4, (int)Math.Round(EDGE * (dpi == 0 ? 96 : dpi) / 96.0));
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x02E0) {   // WM_DPICHANGED: the edge follows the DPI
      base.WndProc(ref m);
      BeginInvoke((Action)PlaceWeb);
      return;
    }
    if (m.Msg == 0x83 && m.WParam != IntPtr.Zero) {   // WM_NCCALCSIZE
      if (IsZoomed(Handle)) {
        // Maximised: exactly the work area, nothing under the taskbar.
        Marshal.StructureToPtr(Work(), m.LParam, false);
      }
      // Otherwise the whole window is client area: no caption, and none of the
      // system's border either. Windows Graphics Capture (Discord) records
      // exactly this rectangle, so a 1080p preset is a 1920 x 1080 picture.
      // The resize edges are a thin black strip inside it (WM_NCHITTEST).
      m.Result = IntPtr.Zero;
      return;
    }
    if (m.Msg == 0x84) {   // WM_NCHITTEST: the black edge the web view leaves resizes the window
      if (IsZoomed(Handle)) { m.Result = (IntPtr)1; return; }
      int sx = (short)((long)m.LParam & 0xFFFF), sy = (short)(((long)m.LParam >> 16) & 0xFFFF);
      RECT w; GetWindowRect(Handle, out w);
      int e = Edge(), c = e * 3;
      bool l = sx < w.L + e, r = sx >= w.R - e, t = sy < w.T + e, b = sy >= w.B - e;
      bool lc = sx < w.L + c, rc = sx >= w.R - c, tc = sy < w.T + c, bc = sy >= w.B - c;
      int hit = 1;
      if ((t && lc) || (l && tc)) hit = 13;
      else if ((t && rc) || (r && tc)) hit = 14;
      else if ((b && lc) || (l && bc)) hit = 16;
      else if ((b && rc) || (r && bc)) hit = 17;
      else if (l) hit = 10;
      else if (r) hit = 11;
      else if (t) hit = 12;
      else if (b) hit = 15;
      m.Result = (IntPtr)hit;
      return;
    }
    if (m.Msg == 0x24) {   // WM_GETMINMAXINFO: a preset may be bigger than the screen
      base.WndProc(ref m);
      var mm = (MINMAXINFO)Marshal.PtrToStructure(m.LParam, typeof(MINMAXINFO));
      mm.maxTrack.X = Math.Max(mm.maxTrack.X, 8192); mm.maxTrack.Y = Math.Max(mm.maxTrack.Y, 8192);
      Marshal.StructureToPtr(mm, m.LParam, false);
      return;
    }
    base.WndProc(ref m);
  }
}
'@

[void][VaultStageForm]::SetProcessDpiAwarenessContext([IntPtr]-4)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[System.Windows.Forms.Application]::EnableVisualStyles()
$f = New-Object VaultStageForm $env:VAULT_STAGE_URL, $env:VAULT_STAGE_UDD, $env:VAULT_STAGE_ARGS, $env:VAULT_STAGE_TITLE, ($env:VAULT_STAGE_MUTE -eq '1')

# Where it opens: last time's spot when it is still on a screen, else a
# 1280 x 720 picture (960 x 540 on a small screen) in the middle of the main one.
$b = "$env:VAULT_STAGE_BOUNDS".Split(',')
$placed = $false
$wantMax = $false
if ($b.Length -ge 4) {
  $r = New-Object System.Drawing.Rectangle ([int]$b[0]), ([int]$b[1]), ([int]$b[2]), ([int]$b[3])
  foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
    $i = [System.Drawing.Rectangle]::Intersect($r, $s.WorkingArea)
    if ($i.Width -ge 64 -and $i.Height -ge 64) { $placed = $true; break }
  }
  if ($placed) { $f.Bounds = $r; $wantMax = ($b.Length -ge 5 -and $b[4] -eq '1') }
}
if (-not $placed) {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $w = 1280; $h = 720
  if ($wa.Width -lt 1500 -or $wa.Height -lt 900) { $w = 960; $h = 540 }
  $f.Bounds = New-Object System.Drawing.Rectangle ([int]($wa.X + ($wa.Width - $w) / 2)), ([int]($wa.Y + ($wa.Height - $h) / 2)), $w, $h
}
$client = "$env:VAULT_STAGE_CLIENT".Split(',')
# Checks only: open minimised, the way a process started minimised does (EnsureShown restores it).
if ("$env:VAULT_STAGE_TEST_MINIMISED" -eq '1') { $f.WindowState = [System.Windows.Forms.FormWindowState]::Minimized }

$f.add_Shown({
  # Shown again once open: a window never shown with SW_SHOW is skipped by
  # Windows Graphics Capture (what Discord uses).
  [void][VaultStageForm]::ShowWindow($f.Handle, 5)
  [void][VaultStageForm]::SetWindowPos($f.Handle, [IntPtr]::Zero, 0, 0, 0, 0, 0x0237)
  # Never left minimised or off every screen, and in front once.
  $f.EnsureShown()
  if ($client.Length -eq 2) { $f.SetClient([int]$client[0], [int]$client[1]) }
  elseif ($wantMax) { $f.WindowState = [System.Windows.Forms.FormWindowState]::Maximized }
  $f.Say(("ready 0x{0:X}" -f $f.Handle.ToInt64()))
  $f.ReportBounds()
})

# Commands from Vault on stdin, and Vault's own exit (threads, in C#).
$f.StartWatchers([int]"0$env:VAULT_STAGE_PARENT")

[System.Windows.Forms.Application]::Run($f)
`;

module.exports = { SCRIPT };
