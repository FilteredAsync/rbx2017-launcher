'use strict';

// Puts the 2017 client's window inside the launcher's window (Settings >
// Menu > Game window). Electron cannot do this itself, so a small PowerShell
// helper (no files on disk: the script goes in on the command line) calls
// Windows directly: it finds the client's main window by its process ID,
// makes it a child window of the launcher's (no title bar or frame), and
// moves it when the launcher's window changes size. "Pop out" puts it back as
// a window of its own. The helper is DPI aware, so sizes are real pixels.
//
//   const embedder = require('./embed')({ log });
//   const handle = await embedder.attach(pid, parentHwnd, rect, timeoutMs)  -> child HWND or null
//   await embedder.move(rect)       rect: { x, y, w, h } in the parent's client area (pixels)
//   await embedder.release(rect)    a window of its own again, at rect (screen pixels)
//   await embedder.focus()          the game becomes the active window (after the launcher's is activated)
//   await embedder.inFront()        the launcher's window or the game is the foreground window
//   embedder.attached()             the child HWND while embedded, else null
//   embedder.stop()

const { spawn } = require('child_process');

const HELPER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GameWindow {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetParent(IntPtr c, IntPtr p);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint t, ref GUITHREADINFO g);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize, flags; public IntPtr active, focus, capture, menuOwner, moveSize, caret; public RECT caretRect; }
  const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  const long WS_CHILD = 0x40000000L, WS_POPUP = 0x80000000L, WS_CAPTION = 0xC00000L, WS_THICKFRAME = 0x40000L,
    WS_SYSMENU = 0x80000L, WS_MINIMIZEBOX = 0x20000L, WS_MAXIMIZEBOX = 0x10000L, WS_CLIPSIBLINGS = 0x4000000L;
  const long WS_EX_APPWINDOW = 0x40000L, WS_EX_WINDOWEDGE = 0x100L, WS_EX_CLIENTEDGE = 0x200L, WS_EX_DLGMODALFRAME = 0x1L;
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;
  static long savedStyle, savedEx;

  public static void PerMonitorDpi() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  // The program's main window: visible, not owned by another window, the biggest.
  public static IntPtr Find(uint pid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, l) => {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea && r.Right - r.Left >= 200) { best = h; bestArea = area; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static string Embed(IntPtr child, IntPtr parent, int x, int y, int w, int h) {
    savedStyle = GetLong(child, GWL_STYLE).ToInt64();
    savedEx = GetLong(child, GWL_EXSTYLE).ToInt64();
    long style = (savedStyle & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)) | WS_CHILD | WS_CLIPSIBLINGS;
    long ex = savedEx & ~(WS_EX_APPWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_DLGMODALFRAME);
    SetLong(child, GWL_STYLE, new IntPtr(style));
    SetLong(child, GWL_EXSTYLE, new IntPtr(ex));
    if (SetParent(child, parent) == IntPtr.Zero && Marshal.GetLastWin32Error() != 0) {
      SetLong(child, GWL_STYLE, new IntPtr(savedStyle));
      SetLong(child, GWL_EXSTYLE, new IntPtr(savedEx));
      return "SetParent failed (" + Marshal.GetLastWin32Error() + ")";
    }
    SetWindowPos(child, IntPtr.Zero, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    return null;
  }

  // The game reads the keyboard and mouse as raw input, which Windows sends
  // only to the program that owns the active (foreground) window. A child
  // window cannot normally be the active one, so when the launcher's window
  // is activated (Alt+Tab, the taskbar, a click) the launcher gets the input
  // and the game none. This makes the game's window the active one again:
  // for a moment it is not marked as a child, which SetActiveWindow needs.
  // Only while the launcher's window is the foreground (never takes it from
  // another program or a launcher dialog), and not during a move, resize,
  // menu or button press on the frame (activating then would cancel it).
  // "active" | "background" | "busy" | "failed"
  public static string Activate(IntPtr child) {
    IntPtr parent = GetAncestor(child, 1);
    Raise(child);
    IntPtr fg = GetForegroundWindow();
    if (fg != parent && fg != child) return "background";
    uint pid; uint thread = GetWindowThreadProcessId(child, out pid);
    GUITHREADINFO g = new GUITHREADINFO(); g.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
    if (fg == parent && GetGUIThreadInfo(GetWindowThreadProcessId(parent, out pid), ref g) && ((g.flags & 0x16) != 0 || g.capture != IntPtr.Zero)) return "busy";
    uint mine = GetCurrentThreadId();
    AttachThreadInput(mine, thread, true);
    try {
      if (fg != child) {
        long style = GetLong(child, GWL_STYLE).ToInt64();
        SetLong(child, GWL_STYLE, new IntPtr(style & ~WS_CHILD));
        SetActiveWindow(child);
        SetLong(child, GWL_STYLE, new IntPtr(style));
      }
      SetFocus(child);
    } finally {
      AttachThreadInput(mine, thread, false);
    }
    return GetForegroundWindow() == child ? "active" : "failed";
  }

  // Above the launcher's own child windows: Chromium makes a new one, on top,
  // each time its window shows again (restored, no longer covered), and the
  // mouse would then go to the launcher's page.
  static void Raise(IntPtr child) {
    IntPtr parent = GetAncestor(child, 1);
    if ((GetLong(child, GWL_STYLE).ToInt64() & WS_CHILD) != 0 && GetWindow(parent, 5) != child) SetWindowPos(child, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  // Keeps the game on top of those (every 250 ms) while it is inside.
  static IntPtr watched = IntPtr.Zero;
  static System.Threading.Timer watcher;
  public static void Watch(IntPtr child) {
    watched = child;
    if (watcher == null) watcher = new System.Threading.Timer(_ => { IntPtr c = watched; if (c != IntPtr.Zero && IsWindow(c)) Raise(c); }, null, 250, 250);
  }
  public static void Unwatch() { watched = IntPtr.Zero; }

  public static bool Front(IntPtr child) {
    IntPtr fg = GetForegroundWindow();
    return fg != IntPtr.Zero && (fg == child || fg == GetAncestor(child, 1));
  }

  public static bool Alive(uint pid) {
    try { System.Diagnostics.Process.GetProcessById((int)pid); return true; } catch { return false; }
  }

  public static void Move(IntPtr child, int x, int y, int w, int h) {
    SetWindowPos(child, IntPtr.Zero, x, y, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }

  // A normal window again: title bar, frame and taskbar button, whatever style
  // the client started with (it is sometimes a frameless popup at first).
  public static void Release(IntPtr child, int x, int y, int w, int h) {
    Unwatch();
    const long WS_OVERLAPPEDWINDOW = 0xCF0000L, WS_VISIBLE = 0x10000000L, WS_CLIPCHILDREN = 0x2000000L;
    SetParent(child, IntPtr.Zero);
    long style = (GetLong(child, GWL_STYLE).ToInt64() & ~(WS_CHILD | WS_POPUP)) | WS_OVERLAPPEDWINDOW | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN;
    SetLong(child, GWL_STYLE, new IntPtr(style));
    SetLong(child, GWL_EXSTYLE, new IntPtr((savedEx & ~WS_EX_DLGMODALFRAME) | WS_EX_APPWINDOW | WS_EX_WINDOWEDGE));
    SetWindowPos(child, IntPtr.Zero, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    SetForegroundWindow(child);
  }
}
'@
[GameWindow]::PerMonitorDpi()
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $reply = @{ ok = $true }
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'find' {
        $until = [DateTime]::UtcNow.AddMilliseconds([int]$c.timeoutMs)
        $found = [IntPtr]::Zero
        while ($found -eq [IntPtr]::Zero -and [DateTime]::UtcNow -lt $until -and [GameWindow]::Alive([uint32]$c.pid)) {
          $found = [GameWindow]::Find([uint32]$c.pid)
          if ($found -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 200 }
        }
        $reply.hwnd = [string]$found.ToInt64()
      }
      'embed' {
        $err = [GameWindow]::Embed([IntPtr][long]$c.child, [IntPtr][long]$c.parent, [int]$c.x, [int]$c.y, [int]$c.w, [int]$c.h)
        if ($err) { $reply.ok = $false; $reply.error = $err } else { [GameWindow]::Watch([IntPtr][long]$c.child) }
      }
      'move' { [GameWindow]::Move([IntPtr][long]$c.child, [int]$c.x, [int]$c.y, [int]$c.w, [int]$c.h) }
      'focus' { $reply.state = [GameWindow]::Activate([IntPtr][long]$c.child) }
      'unwatch' { [GameWindow]::Unwatch() }
      'front' { $reply.front = [GameWindow]::Front([IntPtr][long]$c.child) }
      'release' { [GameWindow]::Release([IntPtr][long]$c.child, [int]$c.x, [int]$c.y, [int]$c.w, [int]$c.h) }
      'exists' { $reply.exists = [GameWindow]::IsWindow([IntPtr][long]$c.child) }
      default { $reply.ok = $false; $reply.error = "unknown op $($c.op)" }
    }
  } catch {
    $reply.ok = $false
    $reply.error = $_.Exception.Message
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Compress))
}
`;

module.exports = function embedder({ log = () => {} } = {}) {
  let helper = null; // { child, ready: Promise, queue: [] }
  let child = null; // the client's window while embedded (decimal string)

  function start() {
    if (helper && helper.process.exitCode === null) return helper;
    const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
    const process = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const state = { process, waiting: [], buffer: '', errors: '' };
    let readyResolve;
    let readyReject;
    state.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', (text) => {
      state.buffer += text;
      let at;
      while ((at = state.buffer.indexOf('\n')) >= 0) {
        const line = state.buffer.slice(0, at).trim();
        state.buffer = state.buffer.slice(at + 1);
        if (!line.startsWith('{')) continue;
        let data;
        try { data = JSON.parse(line); } catch (error) { continue; }
        if (data.ready) { readyResolve(); continue; }
        const next = state.waiting.shift();
        if (next) next.resolve(data);
      }
    });
    process.stderr.on('data', (text) => { state.errors = (state.errors + text).slice(-2000); });
    const failAll = (error) => {
      readyReject(error);
      for (const next of state.waiting.splice(0)) next.reject(error);
    };
    process.on('error', (error) => failAll(new Error(`the window helper did not start: ${error.message}`)));
    process.on('exit', (code) => failAll(new Error(`the window helper stopped (code ${code})${state.errors ? `: ${state.errors.trim().slice(0, 300)}` : ''}`)));
    state.ready.catch(() => {});
    helper = state;
    return state;
  }

  // One command at a time, in order.
  let chain = Promise.resolve();
  function call(command, timeoutMs = 10000) {
    const run = async () => {
      const state = start();
      await state.ready;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the window helper did not answer (${command.op})`)), timeoutMs);
        state.waiting.push({
          resolve: (data) => { clearTimeout(timer); resolve(data); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        state.process.stdin.write(`${JSON.stringify(command)}\n`);
      });
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  }

  const box = (rect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), w: Math.max(1, Math.round(rect.w)), h: Math.max(1, Math.round(rect.h)) });

  // Waits for the program's window (up to timeoutMs) and puts it inside parent.
  async function attach(pid, parentHwnd, rect, timeoutMs = 45000) {
    const found = await call({ op: 'find', pid, timeoutMs }, timeoutMs + 15000);
    if (!found.ok) throw new Error(found.error || 'could not look for the game window');
    if (!found.hwnd || found.hwnd === '0') return null;
    const done = await call(Object.assign({ op: 'embed', child: found.hwnd, parent: String(parentHwnd) }, box(rect)));
    if (!done.ok) throw new Error(done.error || 'could not move the game window');
    child = found.hwnd;
    log('The game window is inside the launcher.');
    await focus().catch(() => {});
    return child;
  }

  async function move(rect) {
    if (!child) return;
    await call(Object.assign({ op: 'move', child }, box(rect)));
  }

  // The game becomes the active window (see Activate above); while a move,
  // resize, menu or frame button press is under way, once it is over.
  let focusing = null;
  function focus() {
    if (!child) return Promise.resolve();
    if (!focusing) {
      focusing = (async () => {
        const until = Date.now() + 20000;
        while (child && Date.now() < until) {
          const done = await call({ op: 'focus', child });
          if (done.state !== 'busy') return done.state;
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return 'busy';
      })().finally(() => { focusing = null; });
    }
    return focusing;
  }

  // The launcher's window or the game is the foreground window.
  async function inFront() {
    if (!child) return false;
    const done = await call({ op: 'front', child });
    return Boolean(done.front);
  }

  async function release(rect) {
    if (!child) return;
    const window = child;
    child = null;
    const exists = await call({ op: 'exists', child: window }).catch(() => ({ exists: false }));
    if (exists.exists) {
      await call(Object.assign({ op: 'release', child: window }, box(rect)));
      log('The game window is a window of its own again.');
    }
  }

  // The game closed: its window is gone with it.
  function forget() {
    child = null;
    if (helper && helper.process.exitCode === null) call({ op: 'unwatch' }).catch(() => {});
  }

  function stop() {
    child = null;
    if (helper && helper.process.exitCode === null) {
      try { helper.process.stdin.end(); } catch (error) { /* gone */ }
      setTimeout(() => { try { helper && helper.process.kill(); } catch (error) { /* gone */ } }, 1000);
    }
  }

  return { attach, move, focus, inFront, release, forget, stop, attached: () => child, warmUp: () => start().ready.catch(() => {}) };
};
