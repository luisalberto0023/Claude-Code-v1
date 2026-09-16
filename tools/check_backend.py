#!/usr/bin/env python3
"""
Run agent_server's real routes in-process, with every way it can move the mouse,
press a key, drive the gamepad or grab the screen replaced by a recorder.

    npm run check:backend                     (finds the project's Python)
    .venv/Scripts/python.exe tools/check_backend.py [name filter]

Why this exists: the backend had no tests, so a regression there was first seen
on the test PC, mid-run. It cannot be tested the obvious way either, because the
routes drive the real mouse and keyboard of whatever machine runs them, and the
machine running the checks is someone's desktop.

How it stays safe, in the order it happens:
  1. AGENT_TEST=1 is set before anything is imported. Backend code that has a
     global side effect beyond input (registering a hotkey, say) checks it and
     skips that step.
  2. Two guards go in underneath everything else.
     On Windows, the user32 functions in USER32_INPUT (injecting input, posting
     messages to windows, moving focus or windows, hooking keys system-wide)
     become recorders inside ctypes itself, so every way of reaching them gets
     the recorder: ctypes.windll.user32, a handle of its own such as
     WinDLL("user32", use_last_error=True), LoadLibrary("user32.dll"), a full
     path, or a WINFUNCTYPE prototype bound by name.
     And the input libraries in UNSTUBBED_INPUT_LIBS (keyboard, pynput,
     pydirectinput, win32api, ...) cannot be imported at all during the run,
     not even lazily inside a route.
     Reaching either guard means some code path got past the named stubs
     below. Nothing reaches the machine, but the run fails so that path gets a
     proper stub.
  3. Stand-in modules replace vgamepad, dxcam, xspeedhack and pygetwindow, so
     no virtual controller is plugged in, no GPU capture is opened, no process is
     injected and no window is moved or focused. The real vgamepad and dxcam do
     work on IMPORT (vgamepad connects to the ViGEm bus), so stubbing after
     import would already be too late.
  4. The real pyautogui is imported and every function on it (and on its
     platform module) is swapped for a recorder, except a few pure helpers named
     in PURE_PYAUTOGUI. pyperclip's copy and paste are swapped the same way, so
     the clipboard is untouched. The real backend imports both unconditionally,
     so on Windows either one failing to import fails the run: the backend
     could not start there. Only elsewhere (a headless Linux session) does a
     stand-in module take the place of one that will not import.
  5. agent_server is imported, its SendInput scan-code sender is swapped, and
     its log directory and memory file are pointed at a temp directory so the
     real game-agent-memory.json and logs/ are never written.
  6. Before the server starts, every input path is checked to be a recorder,
     both guards included. If one is not, nothing is served and the run fails.
The server itself runs under uvicorn on a free port on 127.0.0.1 (never 8765),
in a background thread, and is shut down at the end.

What the guards cannot see: input sent by compiled code that calls Windows
itself (a C extension) or by another process. A library like that needs a
stand-in in import_server before the backend uses it.

Adding a test
-------------
Write a function below the existing tests and register it with @test. It gets
one argument, a Harness, with:

    h.api      talks to the running server:
                 status, body = h.api.get("/health")
                 status, body = h.api.post("/mouse/click", {"x": 10, "y": 10})
               Non-2xx responses are returned, not raised, so rejection paths
               are as easy to test as success. h.api.headers (a fresh copy of
               DEFAULT_HEADERS for each test) go on every request; pass
               headers={...} to add or override per call, with a value of None
               to leave a default header off.
    h.inputs   every stubbed call made since this test started, in order, as
               Call(name, args, kwargs). Names look like "pyautogui.click",
               "sendinput.scan", "vgamepad.press_button", "dxcam.grab", and,
               from the guards, "user32.SendInput" or "import.keyboard".
               h.inputs.named("pyautogui.click") filters.
    h.server   the imported agent_server module, for reading or patching state.
    h.tmp      a temp directory, deleted at the end; LOG_DIR and MEMORY_FILE
               already live inside it.

Fail with expect(condition, "what went wrong"). An exception fails the test
too. For example:

    @test("POST /gamepad/button refuses a button that does not exist")
    def _(h):
        status, body = h.api.post("/gamepad/button", {"button": "turbo"})
        expect(body.get("ok") is False, f"accepted: {body}")
        expect(not h.inputs.calls, f"input reached: {h.inputs.names()}")

Routes still sleep for real (a key hold waits out its duration), so keep the
durations in tests short. A new input library in agent_server (keyboard, pynput,
pydirectinput, win32api, ...) is refused by the import guard until it gets a
stand-in here: build one with stand_in(name) in import_server, before
agent_server is imported. Win32 input written with ctypes needs no stand-in to
be safe, but give it a named sender that import_server swaps, as _send_scan is,
so a test can see what it sent without tripping the user32 guard.
"""

import collections
import enum
import functools
import inspect
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import traceback
import types
import urllib.error
import urllib.request
from pathlib import Path

os.environ["AGENT_TEST"] = "1"
sys.dont_write_bytecode = True  # keep __pycache__ out of the checkout

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Printing must never be what fails a check on a Windows console code page.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(errors="replace")
    except Exception:
        pass

try:
    import fastapi  # noqa: F401
    import pydantic  # noqa: F401
    import uvicorn
except ImportError as e:
    print(f"  FAIL  backend checks need fastapi, pydantic and uvicorn in {sys.executable} ({e}).")
    print("        Run start.bat once (it creates .venv and installs them), or: pip install fastapi uvicorn pydantic")
    sys.exit(1)


# ── Recording ────────────────────────────────────────────────────────────────

Call = collections.namedtuple("Call", "name args kwargs")


class Inputs:
    """Every call that reached a stub. `calls` is cleared before each test;
    `all_calls` is kept for the whole run."""

    def __init__(self):
        self.calls = []
        self.all_calls = []
        self._lock = threading.Lock()  # routes run on uvicorn's thread pool

    def stub(self, name, result=None):
        def recorder(*args, **kwargs):
            call = Call(name, args, kwargs)
            with self._lock:
                self.calls.append(call)
                self.all_calls.append(call)
            return result
        recorder.__name__ = name.rsplit(".", 1)[-1]
        recorder.input_stub = name
        return recorder

    def record(self, name, *args, **kwargs):
        self.stub(name)(*args, **kwargs)

    def named(self, name):
        return [c for c in self.calls if c.name == name]

    def names(self):
        return [c.name for c in self.calls]

    def clear(self):
        with self._lock:
            self.calls.clear()


def is_stub(obj):
    return hasattr(obj, "input_stub")


# ── Stand-ins, installed before agent_server is imported ─────────────────────

SCREEN = (1920, 1080)  # what the stubbed pyautogui.size() reports

# Pure pyautogui helpers that neither read nor drive the devices, left real so
# code that validates keys with them behaves as it does in production.
PURE_PYAUTOGUI = {"isValidKey", "isShiftCharacter"}

# user32 functions that act on the machine rather than read it. Every one is a
# recorder for the whole run, however it is reached (install_user32). Reads such
# as GetForegroundWindow, GetWindowTextW or GetSystemMetrics stay real.
USER32_INPUT = (
    # synthesize input
    "SendInput", "keybd_event", "mouse_event", "SetCursorPos", "SetPhysicalCursorPos",
    "SetKeyboardState", "InjectTouchInput", "InjectSyntheticPointerInput",
    "BlockInput", "ClipCursor",
    # messages to windows: a WM_KEYDOWN posted to a game is input too
    "PostMessageA", "PostMessageW", "PostThreadMessageA", "PostThreadMessageW",
    "SendMessageA", "SendMessageW", "SendMessageTimeoutA", "SendMessageTimeoutW",
    "SendNotifyMessageA", "SendNotifyMessageW",
    # focus, and moving, showing or popping up windows
    "SetForegroundWindow", "SetActiveWindow", "SetFocus", "BringWindowToTop",
    "SwitchToThisWindow", "AttachThreadInput", "ShowWindow", "SetWindowPos",
    "MoveWindow", "MessageBoxA", "MessageBoxW",
    # keys grabbed system-wide
    "RegisterHotKey", "SetWindowsHookExA", "SetWindowsHookExW",
)

# Libraries that can drive input and have no stand-in here yet. None of them
# can be imported during the run (RefuseInputLibs), so a backend that starts
# using one fails the checks until a stand-in is written.
UNSTUBBED_INPUT_LIBS = (
    "keyboard", "mouse", "pynput", "pydirectinput", "pywinauto", "ahk", "autoit",
    "interception", "pyWinhook", "pyHook", "win32api", "win32gui",
)


class SetupFailed(Exception):
    """A problem that means the real backend could not run on this machine
    either. The message names what failed."""


def stand_in(name):
    module = types.ModuleType(name)
    module.is_stand_in = True
    sys.modules[name] = module
    return module


def install_vgamepad(inputs):
    vg = stand_in("vgamepad")

    # Same names and values as vgamepad's own enum, so a typo in a button name
    # fails here the way it would against the real driver.
    class XUSB_BUTTON(enum.IntFlag):
        XUSB_GAMEPAD_DPAD_UP = 0x0001
        XUSB_GAMEPAD_DPAD_DOWN = 0x0002
        XUSB_GAMEPAD_DPAD_LEFT = 0x0004
        XUSB_GAMEPAD_DPAD_RIGHT = 0x0008
        XUSB_GAMEPAD_START = 0x0010
        XUSB_GAMEPAD_BACK = 0x0020
        XUSB_GAMEPAD_LEFT_THUMB = 0x0040
        XUSB_GAMEPAD_RIGHT_THUMB = 0x0080
        XUSB_GAMEPAD_LEFT_SHOULDER = 0x0100
        XUSB_GAMEPAD_RIGHT_SHOULDER = 0x0200
        XUSB_GAMEPAD_GUIDE = 0x0400
        XUSB_GAMEPAD_A = 0x1000
        XUSB_GAMEPAD_B = 0x2000
        XUSB_GAMEPAD_X = 0x4000
        XUSB_GAMEPAD_Y = 0x8000

    methods = ("reset", "update", "press_button", "release_button",
               "left_trigger", "right_trigger", "left_trigger_float", "right_trigger_float",
               "left_joystick", "right_joystick", "left_joystick_float", "right_joystick_float",
               "register_notification", "unregister_notification")

    class VX360Gamepad:
        def __init__(self):
            inputs.record("vgamepad.VX360Gamepad")
            for m in methods:
                setattr(self, m, inputs.stub(f"vgamepad.{m}"))

    vg.XUSB_BUTTON = XUSB_BUTTON
    vg.VX360Gamepad = VX360Gamepad


def install_dxcam(inputs):
    dxcam = stand_in("dxcam")
    try:
        import numpy
    except ImportError:
        numpy = None

    class Camera:
        def grab(self, region=None):
            inputs.record("dxcam.grab", region=region)
            if numpy is None:
                return None
            left, top, right, bottom = region or (0, 0, *SCREEN)
            return numpy.zeros((bottom - top, right - left, 3), dtype=numpy.uint8)

        def __getattr__(self, name):  # start, stop, release, get_latest_frame
            return inputs.stub(f"dxcam.{name}")

    def create(**kwargs):
        inputs.record("dxcam.create", **kwargs)
        return Camera()

    dxcam.create = create


def install_xspeedhack(inputs):
    xsh = stand_in("xspeedhack")

    class Client:
        def __init__(self, **kwargs):
            inputs.record("xspeedhack.Client", **kwargs)
            self.set_speed = inputs.stub("xspeedhack.set_speed")

    xsh.Client = Client


def install_pygetwindow(inputs):
    gw = stand_in("pygetwindow")

    class Window:
        def __init__(self, title, left, top, width, height):
            self.title, self.left, self.top, self.width, self.height = title, left, top, width, height
            for m in ("activate", "close", "minimize", "maximize", "restore",
                      "show", "hide", "move", "moveTo", "resize", "resizeTo"):
                setattr(self, m, inputs.stub(f"pygetwindow.{m}"))

    windows = [Window("Test Game", 100, 100, 800, 600)]
    gw.Window = Window
    gw.getAllWindows = lambda: list(windows)
    gw.getAllTitles = lambda: [w.title for w in windows]
    gw.getWindowsWithTitle = lambda title: [w for w in windows if title.lower() in w.title.lower()]
    gw.getActiveWindow = lambda: windows[0]
    gw.getActiveWindowTitle = lambda: windows[0].title
    gw.getWindowsAt = lambda x, y: []


def cannot_start(module, error):
    """On Windows the backend imports `module` unconditionally, so a stand-in
    would pass the checks for a backend that start.bat cannot start."""
    return SetupFailed(f"{module} imports - {type(error).__name__}: {error} "
                       f"(the real backend cannot start without it)")


def install_pyautogui(inputs):
    try:
        import pyautogui
    except Exception as e:
        if sys.platform == "win32":
            raise cannot_start("pyautogui", e)
        print(f"  note  pyautogui does not import here ({type(e).__name__}); using a stand-in")

        class StandIn(types.ModuleType):
            def __getattr__(self, name):
                if name.startswith("__") or name == "platformModule":
                    raise AttributeError(name)
                return inputs.stub(f"pyautogui.{name}")

        pyautogui = StandIn("pyautogui")
        pyautogui.is_stand_in = True
        sys.modules["pyautogui"] = pyautogui

    def swap(module, prefix):
        for name, obj in list(vars(module).items()):
            if name in PURE_PYAUTOGUI or name.startswith("__"):
                continue
            if inspect.isfunction(obj) or inspect.isbuiltin(obj):
                setattr(module, name, inputs.stub(f"{prefix}.{name}"))

    swap(pyautogui, "pyautogui")
    # The public functions above are all anything calls, but the platform layer
    # beneath them is what actually talks to the OS, so it goes too.
    if getattr(pyautogui, "platformModule", None) is not None:
        swap(pyautogui.platformModule, "pyautogui.platform")
    pyautogui.size = inputs.stub("pyautogui.size", SCREEN)
    pyautogui.position = inputs.stub("pyautogui.position", (SCREEN[0] // 2, SCREEN[1] // 2))


def install_pyperclip(inputs):
    try:
        import pyperclip
    except Exception as e:
        if sys.platform == "win32":
            raise cannot_start("pyperclip", e)
        pyperclip = stand_in("pyperclip")
    pyperclip.copy = inputs.stub("pyperclip.copy")
    pyperclip.paste = inputs.stub("pyperclip.paste", "")


def install_user32(inputs):
    """Make every function in USER32_INPUT a recorder inside ctypes itself, so
    it does not matter which user32 handle the calling code holds."""
    if sys.platform != "win32":
        return
    import ctypes

    # However user32 is loaded (windll.user32, WinDLL("user32.dll",
    # use_last_error=True), a full path, cdll), Windows hands back the same
    # module handle, so the handle is what identifies it.
    user32 = ctypes.WinDLL("user32")._handle

    def refused(name, dll):
        return isinstance(name, str) and name in USER32_INPUT and getattr(dll, "_handle", None) == user32

    # dll.SendInput and dll["SendInput"] both resolve through CDLL.__getitem__,
    # on every handle, including ones created after this runs.
    real_getitem = ctypes.CDLL.__getitem__

    def getitem(dll, name):
        if refused(name, dll):
            return inputs.stub(f"user32.{name}", 1)
        return real_getitem(dll, name)

    ctypes.CDLL.__getitem__ = getitem

    # A prototype bound by name, WINFUNCTYPE(...)(("SendInput", user32)), looks
    # the function up in C without passing through __getitem__, so the two
    # prototype factories get the same check. Each guarded prototype is cached,
    # as ctypes caches its own, so a callback type made twice is still one class.
    def guard_prototypes(real_factory):
        @functools.cache
        def factory(restype, *argtypes, **flags):
            proto = real_factory(restype, *argtypes, **flags)

            class Guarded(proto):
                _flags_, _argtypes_, _restype_ = proto._flags_, proto._argtypes_, proto._restype_

                def __new__(cls, *args):
                    spec = args[0] if args else None
                    if isinstance(spec, tuple) and len(spec) >= 2 and refused(spec[0], spec[1]):
                        return inputs.stub(f"user32.{spec[0]}", 1)
                    return super().__new__(cls, *args)

            return Guarded
        return factory

    ctypes.WINFUNCTYPE = guard_prototypes(ctypes.WINFUNCTYPE)
    ctypes.CFUNCTYPE = guard_prototypes(ctypes.CFUNCTYPE)

    # Anything resolved before this ran is cached on the shared handle; replace it.
    for name in USER32_INPUT:
        setattr(ctypes.windll.user32, name, inputs.stub(f"user32.{name}", 1))


class RefuseInputLibs:
    """Import hook: an input library in UNSTUBBED_INPUT_LIBS cannot be imported
    at any point in the run, so one imported lazily inside a route fails the
    checks instead of driving the real devices."""

    def __init__(self, inputs):
        self.inputs = inputs

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.partition(".")[0]
        if top not in UNSTUBBED_INPUT_LIBS:
            return None
        self.inputs.record(f"import.{top}")
        raise ImportError(f"{fullname} can drive real input and has no stand-in yet: "
                          f"add one in tools/check_backend.py import_server", name=fullname)


def import_server(inputs, tmp):
    sys.meta_path.insert(0, RefuseInputLibs(inputs))
    install_user32(inputs)
    install_vgamepad(inputs)
    install_dxcam(inputs)
    install_xspeedhack(inputs)
    install_pygetwindow(inputs)
    install_pyautogui(inputs)
    install_pyperclip(inputs)

    import agent_server as server

    if hasattr(server, "_send_scan"):
        server._send_scan = inputs.stub("sendinput.scan")
    server.LOG_DIR = Path(tmp) / "logs"
    server.MEMORY_FILE = Path(tmp) / "game-agent-memory.json"
    return server


def resolves_to_stub(resolve, name):
    try:
        return is_stub(resolve(name))
    except Exception:  # not stubbed, and not even there to resolve
        return False


def unstubbed_inputs(server, inputs):
    """Every input path that would still reach the real devices. Empty means it
    is safe to start serving."""
    bad = []
    pag = server.pyautogui
    for module, prefix in ((pag, "pyautogui"), (getattr(pag, "platformModule", None), "pyautogui.platform")):
        if module is None:
            continue
        for name, obj in vars(module).items():
            if name in PURE_PYAUTOGUI or name.startswith("__"):
                continue
            if (inspect.isfunction(obj) or inspect.isbuiltin(obj)) and not is_stub(obj):
                bad.append(f"{prefix}.{name}")
    if hasattr(server, "_send_scan") and not is_stub(server._send_scan):
        bad.append("agent_server._send_scan")
    for attr in ("vg", "dxcam", "xsh", "gw"):
        module = getattr(server, attr, None)
        if module is not None and not getattr(module, "is_stand_in", False):
            bad.append(f"agent_server.{attr} is the real {module.__name__}")
    clipboard = sys.modules.get("pyperclip")
    for name in ("copy", "paste"):
        if clipboard is not None and not is_stub(getattr(clipboard, name, None)):
            bad.append(f"pyperclip.{name}")
    if sys.platform == "win32":
        # Only resolves each function, which is harmless even when the guard is
        # missing; nothing here calls one.
        import ctypes
        own_handle = ctypes.WinDLL("user32", use_last_error=True)
        prototype = ctypes.WINFUNCTYPE(ctypes.c_int)
        for form, resolve in (
            ("windll.user32", lambda n: getattr(ctypes.windll.user32, n)),
            ("WinDLL('user32')", lambda n: getattr(own_handle, n)),
            ("a WINFUNCTYPE prototype", lambda n: prototype((n, ctypes.windll.user32))),
        ):
            real = [n for n in USER32_INPUT if not resolves_to_stub(resolve, n)]
            if real:
                bad.append(f"user32 via {form}: " + ", ".join(real))
    bad += [f"{lib} was imported before the import guard and has no stand-in" for lib in UNSTUBBED_INPUT_LIBS
            if sys.modules.get(lib) is not None and not getattr(sys.modules[lib], "is_stand_in", False)]
    # A refused import that did not stop agent_server loading was caught by a
    # fallback, so the checks would test that fallback, not the backend.
    bad += [f"{c.name[len('import.'):]} was imported while the backend loaded and has no stand-in"
            for c in inputs.all_calls if c.name.startswith("import.")]
    return bad


# ── The server and a client for it ───────────────────────────────────────────

# Headers every test starts with. Each test gets its own copy, so a test that
# changes h.api.headers cannot leak into the next one. When the server starts
# requiring something on every request, set it here once, in import_server.
DEFAULT_HEADERS = {}


class Api:
    def __init__(self, base, headers=None):
        self.base = base
        self.headers = dict(headers or {})
        # A proxy set in the environment must not see requests to 127.0.0.1.
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(self, method, path, body=None, headers=None, timeout=15):
        sent = {**self.headers, **(headers or {})}
        sent = {k: v for k, v in sent.items() if v is not None}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            sent.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(self.base + path, data=data, headers=sent, method=method)
        try:
            with self._opener.open(req, timeout=timeout) as resp:
                return resp.status, _parse(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, _parse(e.read())

    def get(self, path, **kw):
        return self.request("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.request("POST", path, {} if body is None else body, **kw)

    def delete(self, path, **kw):
        return self.request("DELETE", path, **kw)


def _parse(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {"_raw": raw.decode("utf-8", errors="replace")}


def start_server(app):
    # Bind first and hand uvicorn the socket: asking for a free port and then
    # binding it later can lose the port to someone else in between.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
        thread.start()
        deadline = time.monotonic() + 20
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                stop_server(server, thread)
                raise RuntimeError("uvicorn did not start (any error of its own is printed above)")
            time.sleep(0.05)
    except BaseException:
        sock.close()
        raise
    return server, thread, port


def stop_server(server, thread):
    server.should_exit = True
    thread.join(timeout=15)


# ── Tests ────────────────────────────────────────────────────────────────────

TESTS = []


def test(name):
    def register(fn):
        TESTS.append((name, fn))
        return fn
    return register


class CheckFailed(AssertionError):
    pass


def expect(condition, detail=""):
    if not condition:
        raise CheckFailed(detail)


Harness = collections.namedtuple("Harness", "api inputs server tmp")


@test("GET /health reports ok")
def _(h):
    status, body = h.api.get("/health")
    expect(status == 200, f"status {status}: {body}")
    expect(body.get("status") == "ok", f"body {body}")
    expect(not h.inputs.calls, f"health touched input: {h.inputs.names()}")


@test("POST /mouse/click reaches the stub, not the mouse")
def _(h):
    status, body = h.api.post("/mouse/click", {"x": 100, "y": 200, "move_duration": 0})
    expect(status == 200 and body.get("ok") is True, f"status {status}: {body}")
    expect(is_stub(h.server.pyautogui.click), "pyautogui.click is the real function")
    moves = h.inputs.named("pyautogui.moveTo")
    clicks = h.inputs.named("pyautogui.click")
    expect(len(moves) == 1 and moves[0].args[:2] == (100, 200), f"moves recorded: {moves}")
    expect(len(clicks) == 1 and clicks[0].kwargs.get("button") == "left", f"clicks recorded: {clicks}")


@test("POST /mouse/click off the screen is refused before any input")
def _(h):
    status, body = h.api.post("/mouse/click", {"x": SCREEN[0] + 50, "y": 10})
    expect(status == 200 and body.get("ok") is False, f"status {status}: {body}")
    expect(not h.inputs.calls, f"input reached: {h.inputs.names()}")


@test("POST /keyboard/press reaches the scan-code stub")
def _(h):
    status, body = h.api.post("/keyboard/press", {"key": "a", "hold": 0})
    expect(status == 200 and body.get("ok") is True, f"status {status}: {body}")
    if h.server.SENDINPUT_OK:
        scans = h.inputs.named("sendinput.scan")
        expect([c.args[0] for c in scans] == [0x1E, 0x1E], f"scan codes sent: {scans}")
        expect(scans[-1].kwargs.get("keyup") is True, f"no key-up: {scans}")
    else:
        expect(h.inputs.names() == ["pyautogui.keyDown", "pyautogui.keyUp"], f"calls: {h.inputs.names()}")


@test("POST /gamepad/button reaches the vgamepad stand-in")
def _(h):
    status, body = h.api.post("/gamepad/button", {"button": "a", "hold": 0})
    expect(status == 200 and body.get("ok") is True, f"status {status}: {body}")
    pressed = h.inputs.named("vgamepad.press_button")
    released = h.inputs.named("vgamepad.release_button")
    expect(len(pressed) == 1 and pressed[0].kwargs.get("button") == 0x1000, f"pressed: {pressed}")
    expect(len(released) == 1, f"released: {released}")


# ── Memory: outcome names ────────────────────────────────────────────────────
# MEMORY_FILE lives in h.tmp. Each memory test starts from a file it writes
# itself (or none), so the order the tests run in does not matter.

def memory_file(h, data=None):
    """Start the test from `data` in the memory file, or from no file."""
    path = Path(h.server.MEMORY_FILE)
    path.unlink(missing_ok=True)
    if data is not None:
        path.write_text(json.dumps(data), encoding="utf-8")
    return path


@test("POST /memory records every outcome name, and the legacy 'win' as 'won'")
def _(h):
    path = memory_file(h)
    names = ["won", "lost", "stuck", "ended", "aborted"]
    for name in names + ["win"]:
        status, body = h.api.post("/memory/outcomes-test", {"gameDesc": "Outcomes", "outcome": name, "score": 1})
        expect(status == 200 and body.get("ok") is True, f"outcome {name!r}: status {status}: {body}")
    saved = json.loads(path.read_text(encoding="utf-8"))["outcomes-test"]
    expect(saved["outcomes"] == {"won": 2, "lost": 1, "stuck": 1, "ended": 1, "aborted": 1},
           f"outcomes on disk: {saved['outcomes']}")
    expect(saved["scoreHistory"][-1]["outcome"] == "won", f"history: {saved['scoreHistory']}")
    expect(not h.inputs.calls, f"memory touched input: {h.inputs.names()}")


@test("POST /memory refuses an unknown outcome with 422 and writes nothing")
def _(h):
    path = memory_file(h)
    for bad in ("victory", "Won", "", 3):
        status, body = h.api.post("/memory/outcomes-test", {"gameDesc": "Outcomes", "outcome": bad})
        expect(status == 422, f"outcome {bad!r}: status {status}: {body}")
        fields = [d.get("loc", [])[-1] for d in body.get("detail", []) if isinstance(d, dict)]
        expect("outcome" in fields, f"outcome {bad!r}: the refusal does not name the field: {body}")
    expect(not path.exists(), f"a refused patch was written: {path.read_text(encoding='utf-8') if path.exists() else ''}")


@test("Memory folds an old 'win' count into 'won', once")
def _(h):
    path = memory_file(h, {
        "old-game": {
            "gameKey": "old-game", "gameDesc": "Old", "sessions": 6,
            "outcomes": {"won": 2, "win": 3, "lost": 1},
            "scoreHistory": [{"score": 10, "outcome": "win", "session": 5},
                             {"score": 20, "outcome": "lost", "session": 6}],
        },
        "no-wins-yet": {"gameKey": "no-wins-yet", "outcomes": {"win": 4}},
    })
    # Loading shows the folded counts before anything is written back.
    status, body = h.api.get("/memory/old-game")
    expect(status == 200 and body.get("outcomes") == {"won": 5, "lost": 1}, f"GET: status {status}: {body}")
    expect([x["outcome"] for x in body.get("scoreHistory", [])] == ["won", "lost"], f"GET history: {body}")
    status, body = h.api.get("/memory/old-game")
    expect(body.get("outcomes") == {"won": 5, "lost": 1}, f"second GET: {body}")

    # Saving writes the folded counts, for every game in the file, and saving
    # again does not add the old count a second time.
    for _ in range(2):
        status, body = h.api.post("/memory/old-game", {"gameDesc": "Old", "outcome": "lost"})
        expect(status == 200 and body.get("ok") is True, f"POST: status {status}: {body}")
    saved = json.loads(path.read_text(encoding="utf-8"))
    expect(saved["old-game"]["outcomes"] == {"won": 5, "lost": 3}, f"on disk: {saved['old-game']['outcomes']}")
    expect(saved["no-wins-yet"]["outcomes"] == {"won": 4}, f"other game on disk: {saved['no-wins-yet']}")
    expect([x["outcome"] for x in saved["old-game"]["scoreHistory"]] == ["won", "lost"],
           f"history on disk: {saved['old-game']['scoreHistory']}")

    # The fold itself, applied to data it has already folded, changes nothing.
    again = json.loads(json.dumps(saved))
    h.server._fold_legacy_outcomes(again)
    expect(again == saved, f"a second fold changed the data: {again} vs {saved}")
    expect(not h.inputs.calls, f"memory touched input: {h.inputs.names()}")


# ── Run ──────────────────────────────────────────────────────────────────────

def print_raised(check):
    """Report an exception as a FAIL line, so every failure reads the same way."""
    print(f"  FAIL  {check} - raised:")
    print("        " + traceback.format_exc().strip().replace("\n", "\n        "))


def main(argv):
    only = argv[1] if len(argv) > 1 else ""
    selected = [(n, fn) for n, fn in TESTS if only.lower() in n.lower()]
    if not selected:
        print(f"  FAIL  no backend test matches '{only}'")
        return 1

    print("backend")
    inputs = Inputs()
    tmp = tempfile.mkdtemp(prefix="game-agent-backend-")
    failures = 0
    try:
        try:
            server = import_server(inputs, tmp)
        except SetupFailed as e:
            print(f"  FAIL  {e}")
            return 1
        except Exception:
            # The likeliest backend regression of all: a syntax error, or an
            # import that is not installed. Say that, rather than dumping a bare
            # traceback that reads like the harness itself broke.
            print_raised("agent_server imports")
            return 1
        bad = unstubbed_inputs(server, inputs)
        if bad:
            print("  FAIL  every input path is stubbed - still real: " + "; ".join(bad))
            print("        (nothing was served; add a stand-in in tools/check_backend.py)")
            return 1
        print("  ok    every input path is stubbed")

        try:
            uv, thread, port = start_server(server.app)
        except Exception:
            # Most likely a startup hook added to agent_server that raises.
            print_raised("server starts")
            return 1
        try:
            for name, fn in selected:
                inputs.clear()
                api = Api(f"http://127.0.0.1:{port}", DEFAULT_HEADERS)
                try:
                    fn(Harness(api, inputs, server, tmp))
                    print(f"  ok    {name}")
                except CheckFailed as e:
                    failures += 1
                    print(f"  FAIL  {name} - {e}")
                except Exception:
                    failures += 1
                    print_raised(name)
        finally:
            stop_server(uv, thread)

        # The guards record what reached them over the whole run, server startup
        # and shutdown included, so this is checked last.
        leaked = sorted({c.name for c in inputs.all_calls if c.name.startswith("user32.")})
        refused = sorted({c.name[len("import."):] for c in inputs.all_calls if c.name.startswith("import.")})
        if leaked or refused:
            failures += 1
            reasons = []
            if leaked:
                reasons.append("reached user32 directly: " + ", ".join(leaked))
            if refused:
                reasons.append("tried to import, with no stand-in: " + ", ".join(refused))
            print("  FAIL  nothing got past the named stubs - " + "; ".join(reasons))
        else:
            print("  ok    nothing got past the named stubs")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
