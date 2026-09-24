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
  5. agent_server is imported, its SendInput scan-code sender and the sleep and
     clock its holds keep time with are swapped, and
     its log directory, memory file, token file and config file are pointed at
     a temp directory so the real game-agent-memory.json, logs/, .agent-token
     and agent-config.json are never written. It is given a test token
     (TEST_TOKEN), which every request sends unless a test leaves it off. Its
     Ollama relay is pinned to TEST_OLLAMA_BASE, an address that is never
     routed, and the one function it reaches Ollama through (_ollama_open) is
     swapped for a recorder that refuses, so no check talks to a real Ollama
     server unless it stands one up itself.
  6. Before the server starts, every input path is checked to be a recorder,
     both guards included. If one is not, nothing is served and the run fails.
The server itself runs under uvicorn on a free port on 127.0.0.1 (never 8765),
on a socket bound by the backend's own claim_port, in a background thread, and
is shut down at the end.

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
               DEFAULT_HEADERS for each test, which holds the backend's token)
               go on every request; pass headers={...} to add or override per
               call, with a value of None to leave a default header off, e.g.
               headers={"X-Agent-Token": None}.
    h.inputs   every stubbed call made since this test started, in order, as
               Call(name, args, kwargs). Names look like "pyautogui.click",
               "sendinput.scan", "vgamepad.press_button", "dxcam.grab", "wait"
               (a step of a hold), and, from the guards, "user32.SendInput" or
               "import.keyboard".
               h.inputs.named("pyautogui.click") filters.
    h.server   the imported agent_server module, for reading or patching state.
    h.tmp      a temp directory, deleted at the end; LOG_DIR, MEMORY_FILE and
               CONFIG_FILE already live inside it.

A route that talks to Ollama goes through the backend's _ollama_open. Answer it
with with_ollama(h, respond, call) (see the Ollama relay checks).

Every test starts with input not halted and nothing listed as held
(fresh_input_state). A test that halts input does it inside `with halted(h):`,
which lifts the halt however the block ends. A new route that sends input is
declared with @input_route in agent_server.py and needs a body in INPUT_BODIES
here; a new route that takes anything but GET and sends no input goes in
NOT_INPUT_ROUTES here. The kill-switch check fails on a route in neither, since
HaltGate would let it through while input is halted. To halt input after a request got past
the backend's HaltGate (so the route itself must notice), swap _input_halted for
halted_after_gate(). What the backend window would print (_announce) is dropped.

Fail with expect(condition, "what went wrong"). An exception fails the test
too. For example:

    @test("POST /gamepad/button refuses a button that does not exist")
    def _(h):
        status, body = h.api.post("/gamepad/button", {"button": "turbo"})
        expect(body.get("ok") is False, f"accepted: {body}")
        expect(not h.inputs.calls, f"input reached: {h.inputs.names()}")

Holds (a key held or pressed, a gamepad button, a stick or trigger held for a
duration), pointer glides longer than 0.1 s and the gaps between clicks wait
through the backend's _wait, and holds keep time by its _clock. Here _clock is a
FakeClock and _wait its wait: waiting returns at once, moves the fake clock on by
exactly that long, and shows up in h.inputs as Call("wait", (seconds,), {}), in
order with the key-down and key-up around it. A test that swaps _wait for its own
calls the harness's through (wait = h.server._wait before swapping), or the hold
it runs never reaches its deadline; one that wants a sleep to overshoot moves
h.server._clock.now on as well. Other sleeps are still real (a native capture
retries a frame after 20 ms, a clipboard paste waits 0.1 s), so keep those few
in tests. A new input library in agent_server (keyboard, pynput,
pydirectinput, win32api, ...) is refused by the import guard until it gets a
stand-in here: build one with stand_in(name) in import_server, before
agent_server is imported. Win32 input written with ctypes needs no stand-in to
be safe, but give it a named sender that import_server swaps, as _send_scan is,
so a test can see what it sent without tripping the user32 guard.
"""

import collections
import contextlib
import enum
import functools
import inspect
import io
import json
import os
import secrets
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
                return inputs.stub(f"{self.__name__}.{name}")

        pyautogui = StandIn("pyautogui")
        pyautogui.is_stand_in = True
        # A hold lets a key go past pyautogui's fail-safe by catching its exception
        # and calling the platform layer, so the stand-in has both.
        pyautogui.FailSafeException = type("FailSafeException", (Exception,), {})
        pyautogui.platformModule = StandIn("pyautogui.platform")
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


class FakeClock:
    """The backend's _clock, with `wait` as its _wait: waiting records a "wait"
    call and moves `now` on by exactly that long, at once. A hold that has
    stopped waiting would read the clock for ever, so reading it very many times
    with no wait between raises instead, and that check fails rather than hangs."""

    MAX_READS_WITHOUT_WAIT = 100_000

    def __init__(self, inputs):
        self.now = 0.0
        self._reads = 0
        self._record = inputs.stub("wait")

    def __call__(self):
        self._reads += 1
        if self._reads > self.MAX_READS_WITHOUT_WAIT:
            raise RuntimeError(f"the clock was read {self._reads} times with no wait between: a hold that never waits")
        return self.now

    def wait(self, seconds):
        self._record(seconds)
        self._reads = 0
        self.now += seconds


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
    # Key, button, stick and trigger holds keep time by _clock and wait through
    # _wait. With a fake clock that only the recorded wait moves on, a check of a
    # five-second hold takes no time and can see where each wait fell between
    # key-down and key-up.
    if hasattr(server, "_wait"):
        clock = FakeClock(inputs)
        server._wait = clock.wait
        if hasattr(server, "_clock"):
            server._clock = clock
    server.LOG_DIR = Path(tmp) / "logs"
    server.MEMORY_FILE = Path(tmp) / "game-agent-memory.json"
    # What the backend window says when input is halted or resumed is not
    # printed into the checks' output.
    if hasattr(server, "_announce"):
        server._announce = lambda text: None
    # The backend refuses every request without its launch token. Importing it
    # sets none (only running it does), so the tests give it theirs.
    if hasattr(server, "TOKEN_HEADER"):
        server.TOKEN_FILE = Path(tmp) / ".agent-token"
        server.AGENT_TOKEN = TEST_TOKEN
        DEFAULT_HEADERS[server.TOKEN_HEADER] = TEST_TOKEN
    # The Ollama relay chose its server from this machine's environment and
    # agent-config.json on import. The checks give it a fixed one instead, write
    # any config into the temp folder, and reach no server by accident.
    if hasattr(server, "OLLAMA_SERVER"):
        server.CONFIG_FILE = Path(tmp) / "agent-config.json"
        server.OLLAMA_SERVER = server.OllamaServer(TEST_OLLAMA_BASE, "default", None)
        OLLAMA_OPEN["real"] = server._ollama_open
        server._ollama_open = no_ollama_in_checks(inputs)
    return server


# The Ollama server the backend under test relays to: TEST-NET-1, an address
# reserved for documentation that is never routed.
TEST_OLLAMA_BASE = "http://192.0.2.10:11434"
OLLAMA_OPEN = {}  # the backend's real _ollama_open, for the one check that serves its own Ollama


def no_ollama_in_checks(inputs):
    """The backend's _ollama_open while no check has put its own in place: it
    records the attempt (so a check that expects no calls fails) and refuses."""
    def refuse(req, timeout=None):
        inputs.record("ollama.open", req.full_url, timeout=timeout)
        raise ConnectionRefusedError("the backend checks reach no Ollama server")
    return refuse


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

# The token the backend under test accepts (import_server gives it this one),
# made fresh for each run as the backend makes its own.
TEST_TOKEN = secrets.token_urlsafe(32)


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


def start_server(app, bind=None):
    # Bind first and hand uvicorn the socket: asking for a free port and then
    # binding it later can lose the port to someone else in between. `bind` is
    # the backend's own claim_port when it has one, so the socket is set up the
    # way start.bat's backend sets up port 8765.
    if bind is not None:
        sock = bind("127.0.0.1", 0)
    else:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.bind(("127.0.0.1", 0))
    try:
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


# ── Who may use the backend ──────────────────────────────────────────────────
# Any web page open in the browser can send requests to 127.0.0.1, and every
# route here drives the real mouse, keyboard or gamepad, reads the screen or
# writes files. So only the agent page gets in: with this launch's token, from
# its own origin, under a Host of localhost or 127.0.0.1.

TOKEN = "X-Agent-Token"
PAGE = "http://localhost:5173"


def refused_before_running(h, status, body, want, label):
    expect(status == want, f"{label}: status {status}, wanted {want}: {body}")
    expect(not h.inputs.calls, f"{label}: input reached: {h.inputs.names()}")


@test("GET /health answers without the token, and says only ok, whether input is halted and the kill-switch hotkeys")
def _(h):
    status, body = h.api.get("/health", headers={TOKEN: None})
    # No hotkey is registered while the checks run (AGENT_TEST=1).
    expect(status == 200 and body == {"status": "ok", "halted": False, "hotkeys": []}, f"status {status}: {body}")


@test("Every route but GET /health refuses a request without the token, before it runs")
def _(h):
    import re
    routes = [(method, route.path) for route in h.server.app.routes
              for method in sorted(getattr(route, "methods", None) or ())
              if method != "HEAD" and not route.path.startswith(("/docs", "/redoc", "/openapi"))]
    expect(len(routes) >= 25, f"only {len(routes)} routes found: {routes}")
    let_through = []
    for method, path in routes:
        url = re.sub(r"\{[^}]*\}", "access-check", path)
        body = {} if method == "POST" else None
        status, reply = h.api.request(method, url, body, headers={TOKEN: None})
        if (method, path) == ("GET", "/health"):
            continue
        if status != 401 or "reload" not in str(reply.get("detail", "")):
            let_through.append(f"{method} {path} -> {status} {reply}")
    expect(not let_through, "not refused with 401: " + "; ".join(let_through))
    # FastAPI's own pages describe every route, so they are behind the token too,
    # and so is a path that does not exist (a 404 would confirm which do).
    for path in ("/docs", "/openapi.json", "/no-such-route"):
        status, reply = h.api.get(path, headers={TOKEN: None})
        expect(status == 401, f"GET {path} without the token: status {status}: {reply}")
    expect(not h.inputs.calls, f"input reached: {h.inputs.names()}")


@test("A missing, wrong or empty token is refused with 401 on an input route")
def _(h):
    right = h.api.headers[TOKEN]
    for label, token in (("no token", None), ("wrong token", "x" * len(right)),
                         ("token cut short", right[:-1]), ("token with more on the end", right + "x"),
                         ("empty token", ""), ("token in other case", right.swapcase())):
        status, body = h.api.post("/mouse/click", {"x": 100, "y": 100, "move_duration": 0}, headers={TOKEN: token})
        refused_before_running(h, status, body, 401, label)
    # Header names are not case-sensitive, so the page's spelling does not matter.
    status, body = h.api.post("/mouse/move", {"x": 100, "y": 100, "duration": 0},
                              headers={TOKEN: None, "x-agent-token": right})
    expect(status == 200 and body.get("ok") is True, f"lower-case header name: status {status}: {body}")
    # Imported without being run, the backend has no token, and takes none.
    h.server.AGENT_TOKEN = None
    try:
        status, body = h.api.get("/screen/info")
    finally:
        h.server.AGENT_TOKEN = right
    expect(status == 401, f"with no launch token set: status {status}: {body}")
    expect(h.server.token_matches(right.encode(), right) and not h.server.token_matches(None, right)
           and not h.server.token_matches(right.encode(), None), "token_matches")


@test("A foreign Origin is refused with 403, even with the right token")
def _(h):
    for origin in ("https://evil.example", "http://localhost:5174", "null", "http://localhost:5173.evil.example",
                   "http://127.0.0.1:8765", "https://localhost:5173", "http://localhost"):
        for method, path, body in (("POST", "/mouse/click", {"x": 100, "y": 100, "move_duration": 0}),
                                   ("POST", "/keyboard/type", {"text": "hi", "interval": 0}),
                                   ("GET", "/capture/frame", None),
                                   ("GET", "/health", None)):
            status, reply = h.api.request(method, path, body, headers={"Origin": origin})
            refused_before_running(h, status, reply, 403, f"{method} {path} from {origin}")


@test("A foreign Host is refused with 400, even with the right token and Origin")
def _(h):
    # What DNS rebinding looks like: a hostile name that resolves to 127.0.0.1.
    for host in ("evil.example:8765", "evil.example", "localhost.evil.example:8765", "127.0.0.2:8765"):
        status, body = h.api.post("/mouse/click", {"x": 100, "y": 100, "move_duration": 0},
                                  headers={"Host": host, "Origin": PAGE})
        refused_before_running(h, status, body, 400, f"Host {host}")


@test("A refused request with a large body gets its refusal, not a reset connection")
def _(h):
    # The page's log batches and snapshots are megabytes. Refused without their
    # body being read, the connection was reset instead, and through Vite the
    # page saw an empty HTTP 500 rather than the 401 that says to reload.
    body = {"session": "refused", "lines": ["x" * 1000] * 2000}
    for label, headers, want in (("no token", {TOKEN: None}, 401),
                                 ("a foreign Origin", {"Origin": "https://evil.example"}, 403),
                                 ("a foreign Host", {"Host": "evil.example:8765"}, 400)):
        for attempt in range(3):
            try:
                status, reply = h.api.post("/log/append", body, headers=headers)
            except (ConnectionError, urllib.error.URLError) as e:
                expect(False, f"{label}, attempt {attempt + 1}: {type(e).__name__}: {e}")
            expect(status == want, f"{label}: status {status}, wanted {want}: {str(reply)[:200]}")
    expect(not h.server._log_path("refused").exists(), "a refused batch was written")


@test("The agent page gets through: right token, its own Origin, a local Host")
def _(h):
    for origin, host in ((PAGE, "localhost:8765"), ("http://127.0.0.1:5173", "127.0.0.1:8765"), (None, None)):
        extra = {"Origin": origin, "Host": host}
        status, body = h.api.get("/screen/info", headers=extra)
        expect(status == 200 and body.get("width") == SCREEN[0] and body.get("height") == SCREEN[1],
               f"GET /screen/info with {extra}: status {status}: {body}")
        status, body = h.api.post("/mouse/move", {"x": 100, "y": 200, "duration": 0}, headers=extra)
        expect(status == 200 and body.get("ok") is True, f"POST /mouse/move with {extra}: status {status}: {body}")
    expect(len(h.inputs.named("pyautogui.moveTo")) == 3, f"moves: {h.inputs.names()}")


@test("/screen/info and /capabilities hold what /health used to")
def _(h):
    status, body = h.api.get("/screen/info")
    expect(status == 200 and body.get("width") == SCREEN[0] and body.get("height") == SCREEN[1]
           and isinstance(body.get("platform"), str), f"/screen/info: status {status}: {body}")
    Path(h.server.CONFIG_FILE).unlink(missing_ok=True)  # nothing saved for the next start
    status, body = h.api.get("/capabilities")
    flags = {"gamepad", "capture", "windows_api", "speedhack"}
    expect(status == 200 and set(body) == flags | {"ollama"}
           and all(isinstance(body[k], bool) for k in flags), f"/capabilities: status {status}: {body}")
    expect(body["ollama"] == {"base": TEST_OLLAMA_BASE, "source": "default", "error": None, "saved": None},
           f"/capabilities ollama: {body['ollama']}")


@test("launch claims the port before it writes the token, and a failed launch leaves the token alone")
def _(h):
    folder = Path(h.tmp) / "launch"
    folder.mkdir(exist_ok=True)
    token_file = folder / ".agent-token"
    listener, token = h.server.launch({}, token_file, "127.0.0.1", 0)
    try:
        listener.listen()
        port = listener.getsockname()[1]
        expect(port != 8765, "launched on the real port")
        expect(token_file.read_text(encoding="ascii") == token and h.server.TOKEN_PATTERN.fullmatch(token)
               and len(token) >= 43, f"token file holds {token_file.read_text(encoding='ascii')!r}, launch returned {token!r}")
        expect(sorted(p.name for p in folder.iterdir()) == [".agent-token"], f"left behind: {list(folder.iterdir())}")
        # A second copy started by mistake must not replace the running one's token.
        try:
            second = h.server.launch({}, token_file, "127.0.0.1", port)
            second[0].close()
            expect(False, "a second launch bound the same port")
        except h.server.LaunchFailed as e:
            expect("already running" in str(e), f"message: {e}")
        expect(token_file.read_text(encoding="ascii") == token, "a failed second launch rewrote the token")
    finally:
        listener.close()

    listener, again = h.server.launch({}, token_file, "127.0.0.1", 0)
    listener.close()
    expect(again != token and token_file.read_text(encoding="ascii") == again, "a new launch did not make a new token")

    chosen = "A" * 20 + "b" * 20 + "-_0"
    listener, token = h.server.launch({"AGENT_TOKEN": f"  {chosen}\n"}, token_file, "127.0.0.1", 0)
    listener.close()
    expect(token == chosen and token_file.read_text(encoding="ascii") == chosen, f"AGENT_TOKEN not used: {token!r}")
    for bad in ("short", "x" * 31, "has space " * 5, "quote\"" * 8, "x" * 257):
        try:
            h.server.launch({"AGENT_TOKEN": bad}, token_file, "127.0.0.1", 0)[0].close()
            expect(False, f"AGENT_TOKEN {bad!r} was accepted")
        except h.server.LaunchFailed:
            pass
        expect(token_file.read_text(encoding="ascii") == chosen, f"a refused AGENT_TOKEN {bad!r} changed the file")


# ── Off-screen input and oversized writes ────────────────────────────────────

@test("POST /mouse/drag and /mouse/scroll refuse off-screen coordinates before any input")
def _(h):
    w, hgt = SCREEN
    for label, body in (("end off the right", {"x1": 100, "y1": 100, "x2": w + 10, "y2": 100}),
                        ("start above the top", {"x1": 100, "y1": -1, "x2": 200, "y2": 200}),
                        ("end below the bottom", {"x1": 100, "y1": 100, "x2": 200, "y2": hgt})):
        status, reply = h.api.post("/mouse/drag", {**body, "duration": 0})
        expect(status == 200 and reply.get("ok") is False and "outside" in reply.get("error", ""),
               f"drag {label}: status {status}: {reply}")
    for label, body in (("off the left", {"x": -5, "y": 100}), ("off the bottom", {"x": 100, "y": hgt + 1})):
        status, reply = h.api.post("/mouse/scroll", {**body, "amount": -3})
        expect(status == 200 and reply.get("ok") is False and "outside" in reply.get("error", ""),
               f"scroll {label}: status {status}: {reply}")
    expect(not h.inputs.calls, f"input reached: {h.inputs.names()}")

    status, reply = h.api.post("/mouse/drag", {"x1": 100, "y1": 100, "x2": 300, "y2": 400, "duration": 0})
    expect(status == 200 and reply.get("ok") is True, f"on-screen drag: status {status}: {reply}")
    # pyautogui.dragTo's own three steps, taken apart so a halt can stop the move.
    expect([(c.name, c.args[:2], c.kwargs.get("button")) for c in h.inputs.calls]
           == [("pyautogui.moveTo", (100, 100), None), ("pyautogui.mouseDown", (), "left"),
               ("pyautogui.moveTo", (300, 400), None), ("pyautogui.mouseUp", (), "left")],
           f"drag: {h.inputs.calls}")
    h.inputs.clear()
    status, reply = h.api.post("/mouse/scroll", {"x": 500, "y": 500, "amount": -3})
    expect(status == 200 and reply.get("ok") is True, f"on-screen scroll: status {status}: {reply}")
    scrolls = h.inputs.named("pyautogui.scroll")
    expect(len(scrolls) == 1 and scrolls[0].args[:1] == (-3,), f"scrolls: {scrolls}")


@test("POST /log/snapshot refuses an oversized snapshot with 413 and writes nothing")
def _(h):
    limit = h.server.SNAPSHOT_MAX_BYTES
    expect(limit == 8 * 1024 * 1024, f"SNAPSHOT_MAX_BYTES is {limit}")
    folder = Path(h.server.LOG_DIR) / "snapshots" / "size-check"
    shutil.rmtree(folder, ignore_errors=True)
    over = "A" * ((limit // 3 + 1) * 4)  # base64 of limit + 3 bytes
    for label, body in (("an image over the limit", {"png": over}),
                        ("text over the limit", {"text": "x" * (limit + 1)}),
                        ("an image and text over the limit together", {"png": "A" * (limit // 2 // 3 * 4), "text": "x" * (limit // 2 + 8)})):
        status, reply = h.api.post("/log/snapshot", {"session": "size-check", "tag": "big", **body})
        expect(status == 413 and reply.get("ok") is False and "limit" in reply.get("error", ""),
               f"{label}: status {status}: {str(reply)[:200]}")
    expect(not folder.exists() or not any(folder.iterdir()), f"written: {list(folder.iterdir()) if folder.exists() else []}")

    status, reply = h.api.post("/log/snapshot", {"session": "size-check", "tag": "small",
                                                 "png": "iVBORw0KGgo=", "text": "board"})
    expect(status == 200 and reply.get("ok") is True and len(reply.get("files", [])) == 2,
           f"a small snapshot: status {status}: {reply}")


@test("POST /log/append refuses too many lines or bytes with 413 and writes nothing")
def _(h):
    max_lines, max_bytes = h.server.LOG_APPEND_MAX_LINES, h.server.LOG_APPEND_MAX_BYTES
    path = h.server._log_path("append-check")
    path.unlink(missing_ok=True)
    for label, lines in (("one line too many", ["x"] * (max_lines + 1)),
                         ("one byte too many", ["x" * (max_bytes // 2 - 1), "y" * (max_bytes // 2)])):
        status, reply = h.api.post("/log/append", {"session": "append-check", "lines": lines})
        expect(status == 413 and reply.get("ok") is False, f"{label}: status {status}: {str(reply)[:200]}")
    expect(not path.exists(), f"a refused batch was written: {path}")

    # Exactly at both limits is accepted, and so is half an emoji (a line the
    # page cut short mid-character), which used to fail the whole batch.
    for label, lines in (("the most lines", ["x"] * max_lines),
                         ("the most bytes", ["x" * (max_bytes // 2 - 1), "y" * (max_bytes // 2 - 1)]),
                         ("half an emoji", ["cut here: \ud83d", "next line"])):
        status, reply = h.api.post("/log/append", {"session": "append-check", "lines": lines})
        expect(status == 200 and reply.get("ok") is True, f"{label}: status {status}: {str(reply)[:200]}")
    written = path.read_text(encoding="utf-8").splitlines()
    expect(len(written) == max_lines + 4 and written[-1] == "next line", f"{len(written)} lines written")


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


# ── Holds and typed text ─────────────────────────────────────────────────────
# A key hold used to sleep for whatever it was sent: 600 held a key down for ten
# minutes that nothing could interrupt, and typed text had no limit. Every hold
# is now cut to a few seconds, waits in short steps that ask _input_halted()
# before each, and lets go of what it pressed however it ends; typed text is cut
# to TYPE_TEXT_MAX_CHARS. Each reply's "limit" says what was asked and what was
# done. _wait is a recorder here, so no hold below really waits.

def halted_after_gate():
    """An _input_halted that says no once, to HaltGate, and yes from then on:
    a halt that lands after the request got past the gate, which the route
    itself has to notice."""
    answers = iter([False])
    return lambda: next(answers, True)


@contextlib.contextmanager
def swapped(target, **attrs):
    """Set attributes on `target` (a module, usually h.server) for a with block."""
    before = {name: getattr(target, name) for name in attrs}
    for name, value in attrs.items():
        setattr(target, name, value)
    try:
        yield
    finally:
        for name, value in before.items():
            setattr(target, name, value)


def key_paths(h):
    """Each way the backend sends keys, as (method, the key ids it sends, patches
    that make it take that way): SendInput scan codes where it has them
    (Windows), and pyautogui for a key without one (and on other systems)."""
    paths = [("pyautogui", {"ctrl": "ctrl", "shift": "shift", "a": "a"}, {"_scan_for": lambda key: None})]
    if h.server.SENDINPUT_OK:
        paths.insert(0, ("sendinput", {"ctrl": 0x1D, "shift": 0x2A, "a": 0x1E}, {}))
    return paths


def key_events(h):
    """The key-downs, key-ups and hold steps sent so far, in order, as ("down", key),
    ("up", key) and ("wait", seconds), whichever way the keys went."""
    events = []
    for c in h.inputs.calls:
        if c.name == "sendinput.scan":
            events.append(("up" if c.kwargs.get("keyup") else "down", c.args[0]))
        elif c.name in ("pyautogui.keyDown", "pyautogui.keyUp"):
            events.append(("down" if c.name == "pyautogui.keyDown" else "up", c.args[0]))
        elif c.name == "wait":
            events.append(("wait", round(c.args[0], 6)))
    return events


def seconds_limit(requested, applied, low, high):
    return {"requested": requested, "applied": applied, "min": low, "max": high, "unit": "s",
            "clamped": applied != requested}


@test("POST /keyboard/hold cuts a 600 s hold to 5 s, held in 0.1 s steps without really waiting, and lets the key up")
def _(h):
    expect((h.server.KEY_HOLD_MAX_S, h.server.HOLD_STEP_S) == (5.0, 0.1),
           f"KEY_HOLD_MAX_S {h.server.KEY_HOLD_MAX_S}, HOLD_STEP_S {h.server.HOLD_STEP_S}")
    for method, ids, patches in key_paths(h):
        with swapped(h.server, **patches):
            h.inputs.clear()
            started = time.monotonic()
            status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": 600})
            took = time.monotonic() - started
            events = key_events(h)
            expect(status == 200 and body.get("ok") is True and body.get("method") == method,
                   f"{method}, 600 s: status {status}: {body}")
            expect(body.get("limit") == seconds_limit(600, 5, 0, 5) and body.get("held") == 5 and body.get("halted") is False,
                   f"{method}, 600 s: reply {body}")
            expect(events == [("down", ids["a"])] + [("wait", 0.1)] * 50 + [("up", ids["a"])],
                   f"{method}, 600 s: {len(events)} events: {events[:3]} ... {events[-3:]}")
            expect(took < 3, f"{method}, 600 s: took {took:.1f} s, so something slept for real")

            # Within the limit it holds as asked, the last step making up the rest,
            # and a combination goes down in order and comes up in reverse.
            h.inputs.clear()
            status, body = h.api.post("/keyboard/hold", {"key": "ctrl+shift+a", "duration": 0.25})
            expect(status == 200 and body.get("ok") is True and body.get("limit") == seconds_limit(0.25, 0.25, 0, 5)
                   and body.get("held") == 0.25, f"{method}, 0.25 s: status {status}: {body}")
            expect(key_events(h) == [("down", ids["ctrl"]), ("down", ids["shift"]), ("down", ids["a"]),
                                     ("wait", 0.1), ("wait", 0.1), ("wait", 0.05),
                                     ("up", ids["a"]), ("up", ids["shift"]), ("up", ids["ctrl"])],
                   f"{method}, 0.25 s: {key_events(h)}")

            # Below zero is a tap, and says it was raised to 0.
            h.inputs.clear()
            status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": -3})
            expect(status == 200 and body.get("ok") is True and body.get("limit") == seconds_limit(-3, 0, 0, 5),
                   f"{method}, -3 s: status {status}: {body}")
            expect(key_events(h) == [("down", ids["a"]), ("up", ids["a"])], f"{method}, -3 s: {key_events(h)}")


@test("POST /keyboard/hold lets every key up when a step or a press fails, or input is halted part-way")
def _(h):
    for method, ids, patches in key_paths(h):
        with swapped(h.server, **patches):
            # A step that raises part-way through the hold.
            wait = h.server._wait
            steps = []

            def breaking_wait(seconds):
                wait(seconds)
                steps.append(seconds)
                if len(steps) == 3:
                    raise RuntimeError("the hold broke")

            h.inputs.clear()
            with swapped(h.server, _wait=breaking_wait):
                status, body = h.api.post("/keyboard/hold", {"key": "ctrl+a", "duration": 4})
            expect(status == 200 and body.get("ok") is False and "the hold broke" in body.get("error", "")
                   and body.get("limit") == seconds_limit(4, 4, 0, 5), f"{method}, a step raised: status {status}: {body}")
            expect(key_events(h) == [("down", ids["ctrl"]), ("down", ids["a"])] + [("wait", 0.1)] * 3
                   + [("up", ids["a"]), ("up", ids["ctrl"])], f"{method}, a step raised: {key_events(h)}")

            # Input halted after three steps: the keys come up at once.
            h.inputs.clear()
            with swapped(h.server, _input_halted=lambda: len(h.inputs.named("wait")) >= 3):
                status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": 600})
            expect(status == 200 and body.get("ok") is True and body.get("halted") is True
                   and abs(body.get("held", 0) - 0.3) < 1e-6 and body.get("limit") == seconds_limit(600, 5, 0, 5),
                   f"{method}, halted: status {status}: {body}")
            expect(key_events(h) == [("down", ids["a"])] + [("wait", 0.1)] * 3 + [("up", ids["a"])],
                   f"{method}, halted: {key_events(h)}")

            # Input halted by the time the hold starts, after the request got past
            # HaltGate: nothing goes down at all (pressing and at once letting go
            # would still be a tap).
            h.inputs.clear()
            with swapped(h.server, _input_halted=halted_after_gate()):
                status, body = h.api.post("/keyboard/hold", {"key": "ctrl+a", "duration": 2})
            expect(status == 200 and body.get("ok") is True and body.get("halted") is True and body.get("held") == 0
                   and body.get("limit") == seconds_limit(2, 2, 0, 5), f"{method}, halted before: status {status}: {body}")
            expect(not h.inputs.calls, f"{method}, halted before: input reached: {h.inputs.names()}")

            # The second key fails to go down: it and the first are let go, and the
            # hold never starts. Then a release that fails does not stop the others.
            if method == "sendinput":
                def fail_on(key, up):
                    def send(scan, **kw):
                        h.inputs.record("sendinput.scan", scan, **kw)
                        if scan == ids[key] and bool(kw.get("keyup")) is up:
                            raise OSError(f"SendInput failed on {key}")
                    return swapped(h.server, _send_scan=send)
            else:
                def fail_on(key, up):
                    name = "keyUp" if up else "keyDown"

                    def send(k, *args, **kw):
                        h.inputs.record(f"pyautogui.{name}", k, *args, **kw)
                        if k == key:
                            raise OSError(f"pyautogui failed on {key}")
                    return swapped(h.server.pyautogui, **{name: send})

            h.inputs.clear()
            with fail_on("shift", up=False):
                status, body = h.api.post("/keyboard/hold", {"key": "ctrl+shift+a", "duration": 2})
            expect(status == 200 and body.get("ok") is False and "failed on shift" in body.get("error", ""),
                   f"{method}, a press raised: status {status}: {body}")
            expect(key_events(h) == [("down", ids["ctrl"]), ("down", ids["shift"]), ("up", ids["shift"]), ("up", ids["ctrl"])],
                   f"{method}, a press raised: {key_events(h)}")

            h.inputs.clear()
            with fail_on("a", up=True):
                status, body = h.api.post("/keyboard/hold", {"key": "ctrl+shift+a", "duration": 0.1})
            expect(status == 200 and body.get("ok") is False and "failed on a" in body.get("error", ""),
                   f"{method}, a release raised: status {status}: {body}")
            expect(key_events(h)[-3:] == [("up", ids["a"]), ("up", ids["shift"]), ("up", ids["ctrl"])],
                   f"{method}, a release raised: {key_events(h)}")
            expect(not h.inputs.named("pyautogui.platform._keyUp"),
                   f"{method}, a release raised: an error other than the fail-safe went past pyautogui: {h.inputs.names()}")

            if method == "pyautogui":
                # The mouse moved into a screen corner during the hold (someone
                # trying to stop it): pyautogui's fail-safe refuses every call from
                # then on, key-ups included, so the key-up goes to its platform layer.
                def refused_up(k, *args, **kw):
                    h.inputs.record("pyautogui.keyUp", k, *args, **kw)
                    raise h.server.pyautogui.FailSafeException("the mouse is in a screen corner")

                h.inputs.clear()
                with swapped(h.server.pyautogui, keyUp=refused_up):
                    status, body = h.api.post("/keyboard/hold", {"key": "ctrl+a", "duration": 0.2})
                ups = [c.args[0] for c in h.inputs.named("pyautogui.platform._keyUp")]
                expect(status == 200 and body.get("ok") is True, f"fail-safe during the hold: status {status}: {body}")
                expect(ups == ["a", "ctrl"], f"fail-safe during the hold: keys left down; calls {h.inputs.names()}")


@test("POST /keyboard/hold ends on time when every sleep overshoots, rather than adding the overshoot up")
def _(h):
    # time.sleep on Windows before Python 3.11 can wake a whole timer tick late,
    # about 15.6 ms. Fifty steps each that late would make a 5 s hold last 5.78 s.
    clock, wait = h.server._clock, h.server._wait

    def late_wait(seconds):
        wait(seconds)
        clock.now += 0.0156

    for method, ids, patches in key_paths(h):
        with swapped(h.server, _wait=late_wait, **patches):
            for duration in (5, 0.25):
                h.inputs.clear()
                started = clock.now
                status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": duration})
                took = clock.now - started
                expect(status == 200 and body.get("ok") is True and body.get("held") == duration and body.get("halted") is False,
                       f"{method}, {duration} s: status {status}: {body}")
                expect(duration - 1e-6 <= took <= duration + 0.0156 + 1e-6,
                       f"{method}, {duration} s: held for {took:.4f} s by the clock, in {len(h.inputs.named('wait'))} steps")


@test("POST /keyboard/hold bounds NaN and Infinity too, and refuses a duration that is no number, or no key, before any input")
def _(h):
    # JSON has no NaN or Infinity, but the backend's parser reads them. A NaN used
    # to pass min() and max() untouched, and a refusal that repeats either one
    # cannot be sent (an HTTP 500), so they are bounded like any other value.
    for label, duration, applied, shown in (("NaN", float("nan"), 0, "nan"), ("Infinity", float("inf"), 5, "inf"),
                                            ("-Infinity", float("-inf"), 0, "-inf")):
        h.inputs.clear()
        status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": duration})
        steps = [c.args[0] for c in h.inputs.named("wait")]
        expect(status == 200 and body.get("ok") is True
               and body.get("limit") == {"requested": shown, "applied": applied, "min": 0, "max": 5, "unit": "s", "clamped": True},
               f"duration {label}: status {status}: {body}")
        expect(abs(sum(steps) - applied) < 1e-6, f"duration {label}: waited {steps}")
    for label, duration in (("text", "long"), ("null", None)):
        h.inputs.clear()
        status, body = h.api.post("/keyboard/hold", {"key": "a", "duration": duration})
        refused_before_running(h, status, body, 422, f"duration {label}")
    status, body = h.api.post("/keyboard/hold", {"key": "a"})
    refused_before_running(h, status, body, 422, "no duration")
    for key in ("", "+", " + "):
        status, body = h.api.post("/keyboard/hold", {"key": key, "duration": 1})
        expect(status == 200 and body.get("ok") is False and "no key" in body.get("error", ""), f"key {key!r}: status {status}: {body}")
        expect(not h.inputs.calls, f"key {key!r}: input reached: {h.inputs.names()}")


@test("POST /keyboard/type types at most 300 characters, says how many it left out, and bounds the interval")
def _(h):
    most = h.server.TYPE_TEXT_MAX_CHARS
    expect(most == 300, f"TYPE_TEXT_MAX_CHARS is {most}")

    def chars_limit(requested, applied):
        return {"requested": requested, "applied": applied, "min": 0, "max": most, "unit": "characters",
                "clamped": applied != requested}

    text = "".join(chr(ord("a") + i % 26) for i in range(1000))
    status, body = h.api.post("/keyboard/type", {"text": text, "interval": 0})
    typed = h.inputs.named("pyautogui.typewrite")
    expect(status == 200 and body.get("ok") is True and body.get("limit") == chars_limit(1000, 300), f"1000 characters: status {status}: {body}")
    expect(len(typed) == 1 and typed[0].args == (text[:300],), f"1000 characters: typed {[len(c.args[0]) for c in typed]}")

    h.inputs.clear()
    status, body = h.api.post("/keyboard/type", {"text": text[:300], "interval": 0})
    typed = h.inputs.named("pyautogui.typewrite")
    expect(body.get("ok") is True and body.get("limit") == chars_limit(300, 300) and typed[0].args == (text[:300],),
           f"exactly 300: {body}; typed {typed}")

    # Text with characters typewrite cannot type goes through the clipboard, cut the same way.
    for label, char in (("accented", "é"), ("an emoji", "\U0001F600")):
        h.inputs.clear()
        status, body = h.api.post("/keyboard/type", {"text": char * 1000, "interval": 0})
        copied = h.inputs.named("pyperclip.copy")
        expect(status == 200 and body.get("ok") is True and body.get("limit") == chars_limit(1000, 300),
               f"{label}: status {status}: {body}")
        expect(len(copied) == 1 and copied[0].args == (char * 300,) and h.inputs.named("pyautogui.hotkey"),
               f"{label}: copied {[len(c.args[0]) for c in copied]}, calls {h.inputs.names()}")

    # The page sends its timing profile's interval (0.08 s at most); a larger one
    # would stretch 300 characters over many minutes.
    # Typed a few characters at a time (each piece about HOLD_STEP_S long), so a
    # halt can stop the rest: at 0.2 s apart, one at a time.
    for given, used, pieces in ((0.03, 0.03, ["hi"]), (10, h.server.TYPE_INTERVAL_MAX_S, ["h", "i"]), (-1, 0.0, ["hi"]),
                                (float("inf"), h.server.TYPE_INTERVAL_MAX_S, ["h", "i"]), (float("nan"), 0.0, ["hi"])):
        h.inputs.clear()
        status, body = h.api.post("/keyboard/type", {"text": "hi", "interval": given})
        typed = h.inputs.named("pyautogui.typewrite")
        expect(body.get("ok") is True and [c.args[0] for c in typed] == pieces
               and all(c.kwargs.get("interval") == used for c in typed), f"interval {given}: {body}; typed {typed}")
    expect(h.server.TYPE_INTERVAL_MAX_S * most <= 60, f"300 characters can take {h.server.TYPE_INTERVAL_MAX_S * most} s")


@test("Gamepad button, stick and trigger holds are cut to 5 s, held in steps, say so, and always let go")
def _(h):
    expect((h.server.GAMEPAD_HOLD_MAX_S, h.server.GAMEPAD_BUTTON_MIN_S) == (5.0, 0.02),
           f"GAMEPAD_HOLD_MAX_S {h.server.GAMEPAD_HOLD_MAX_S}, GAMEPAD_BUTTON_MIN_S {h.server.GAMEPAD_BUTTON_MIN_S}")

    def pad_events():
        events = []
        for c in h.inputs.calls:
            if c.name == "wait":
                events.append(("wait", round(c.args[0], 6)))
            elif c.name in ("vgamepad.press_button", "vgamepad.release_button"):
                events.append((c.name.split(".")[1], c.kwargs.get("button")))
            elif c.name.endswith(("_joystick_float", "_trigger_float")):
                events.append((c.name.split(".")[1], *c.kwargs.values()))
            elif c.name == "vgamepad.update":
                events.append(("update",))
        return events

    a = 0x1000
    for hold, applied, steps in ((60, 5, [0.1] * 50), (0, 0.02, [0.02]), (0.08, 0.08, [0.08])):
        h.inputs.clear()
        status, body = h.api.post("/gamepad/button", {"button": "a", "hold": hold})
        expect(status == 200 and body.get("ok") is True and body.get("limit") == seconds_limit(hold, applied, 0.02, 5)
               and abs(body.get("held", -1) - applied) < 1e-6 and body.get("halted") is False,
               f"button hold {hold}: status {status}: {body}")
        expect(pad_events() == [("press_button", a), ("update",)] + [("wait", s) for s in steps]
               + [("release_button", a), ("update",)], f"button hold {hold}: {pad_events()}")

    wait = h.server._wait

    def breaking_wait(seconds):
        wait(seconds)
        raise RuntimeError("the hold broke")

    h.inputs.clear()
    with swapped(h.server, _wait=breaking_wait):
        status, body = h.api.post("/gamepad/button", {"button": "a", "hold": 3})
    expect(body.get("ok") is False and "the hold broke" in body.get("error", ""), f"button, a step raised: {body}")
    expect(pad_events()[-2:] == [("release_button", a), ("update",)], f"button, a step raised: {pad_events()}")

    # A stick or trigger with a duration goes back to rest after it; with none it
    # stays where it was put, as the tool says.
    for route, body, moved, rest in (
        ("/gamepad/stick", {"stick": "left", "x": 0.5, "y": -1}, ("left_joystick_float", 0.5, -1.0), ("left_joystick_float", 0.0, 0.0)),
        ("/gamepad/trigger", {"trigger": "right", "value": 1}, ("right_trigger_float", 1.0), ("right_trigger_float", 0.0)),
    ):
        for duration, applied, steps, back in ((30, 5, [0.1] * 50, True), (0.3, 0.3, [0.1] * 3, True), (0, 0, [], False)):
            h.inputs.clear()
            status, reply = h.api.post(route, {**body, "duration": duration})
            expect(status == 200 and reply.get("ok") is True and reply.get("limit") == seconds_limit(duration, applied, 0, 5)
                   and reply.get("halted") is False, f"{route} duration {duration}: status {status}: {reply}")
            want = [moved, ("update",)] + [("wait", s) for s in steps] + ([rest, ("update",)] if back else [])
            expect(pad_events() == want, f"{route} duration {duration}: {pad_events()}")

        h.inputs.clear()
        with swapped(h.server, _input_halted=lambda: len(h.inputs.named("wait")) >= 2):
            status, reply = h.api.post(route, {**body, "duration": 5})
        expect(reply.get("ok") is True and reply.get("halted") is True and abs(reply.get("held", 0) - 0.2) < 1e-6,
               f"{route}, halted: {reply}")
        expect(pad_events() == [moved, ("update",), ("wait", 0.1), ("wait", 0.1), rest, ("update",)], f"{route}, halted: {pad_events()}")

        h.inputs.clear()
        with swapped(h.server, _wait=breaking_wait):
            status, reply = h.api.post(route, {**body, "duration": 2})
        expect(reply.get("ok") is False and pad_events()[-2:] == [rest, ("update",)], f"{route}, a step raised: {reply}; {pad_events()}")

    # Once input is halted (here after the request got past HaltGate), a button
    # is not pressed and a stick or trigger is not moved, with or without a duration.
    for route, body in (("/gamepad/button", {"button": "a", "hold": 1}),
                        ("/gamepad/stick", {"stick": "left", "x": 1, "y": 1, "duration": 0}),
                        ("/gamepad/stick", {"stick": "left", "x": 1, "y": 1, "duration": 2}),
                        ("/gamepad/trigger", {"trigger": "left", "value": 1, "duration": 0})):
        h.inputs.clear()
        with swapped(h.server, _input_halted=halted_after_gate()):
            status, reply = h.api.post(route, body)
        expect(status == 200 and reply.get("ok") is True and reply.get("halted") is True and reply.get("held") == 0,
               f"{route} {body}, halted before: status {status}: {reply}")
        expect(not [e for e in pad_events() if e != ("update",)] and not h.inputs.named("wait"),
               f"{route} {body}, halted before: input reached: {h.inputs.names()}")

    # NaN and Infinity are bounded too: a NaN button press is the shortest one, a
    # NaN stick or trigger duration leaves it where it was put.
    for route, field, value, applied, shown in (("/gamepad/button", "hold", float("inf"), 5, "inf"),
                                                 ("/gamepad/button", "hold", float("nan"), 0.02, "nan"),
                                                 ("/gamepad/stick", "duration", float("inf"), 5, "inf"),
                                                 ("/gamepad/stick", "duration", float("nan"), 0, "nan"),
                                                 ("/gamepad/trigger", "duration", float("-inf"), 0, "-inf")):
        h.inputs.clear()
        status, reply = h.api.post(route, {"button": "a", field: value})
        low = 0.02 if field == "hold" else 0
        steps = [c.args[0] for c in h.inputs.named("wait")]
        expect(status == 200 and reply.get("ok") is True
               and reply.get("limit") == {"requested": shown, "applied": applied, "min": low, "max": 5, "unit": "s", "clamped": True}
               and abs(sum(steps) - applied) < 1e-6, f"{route} {field} {value}: status {status}: {reply}; waited {steps}")


# ── Kill switch ──────────────────────────────────────────────────────────────
# The mouse in a screen corner only ever stopped pyautogui's own calls: keys go
# out through SendInput and the gamepad through vgamepad, and ■ Stop only stopped
# the page asking for more. Input now has a halt flag, set by a hotkey, the
# page's Stop or POST /session/halt: while it is set every input route refuses
# with 423, whatever is held is let go at once, a hold or glide under way stops
# within a step, and only POST /session/resume lifts it.

# A body each input route accepts, so a route the gate wrongly let through would
# really send input, and the check would see it.
INPUT_BODIES = {
    "/mouse/move": {"x": 100, "y": 100, "duration": 0},
    "/mouse/click": {"x": 100, "y": 100, "move_duration": 0},
    "/mouse/drag": {"x1": 100, "y1": 100, "x2": 200, "y2": 200, "duration": 0},
    "/mouse/scroll": {"x": 100, "y": 100, "amount": -1},
    "/keyboard/press": {"key": "a", "hold": 0},
    "/keyboard/hold": {"key": "a", "duration": 0.1},
    "/keyboard/type": {"text": "hi", "interval": 0},
    "/gamepad/button": {"button": "a", "hold": 0.02},
    "/gamepad/stick": {"stick": "left", "x": 1, "y": 0, "duration": 0},
    "/gamepad/trigger": {"trigger": "right", "value": 1, "duration": 0},
    "/game/attach": {"process": "game.exe"},
    "/game/speed": {"speed": 0},
}


# Every route that takes anything but GET and sends no input, each named, so that
# a new route is put on one side or the other on purpose. Going by its path would
# miss one that sends input from anywhere else (a route that brings a window to
# the front for a game with no plugin, say), and HaltGate would let it through.
NOT_INPUT_ROUTES = {
    "/session/halt", "/session/resume",    # the kill switch itself
    "/log/append", "/log/snapshot",        # files under logs/
    "/memory/{game_key}",                  # game-agent-memory.json (POST and DELETE)
    "/llm/ollama", "/config/ollama-base",  # the model relay, and its server for the next start
    "/capture/select",                     # which screen region is captured; no window is moved or focused
    "/game/detach",                        # sets the game back to normal speed, as a halt does
}


def writing_routes(h):
    """Every route that takes anything but GET (a GET sends no input: HaltGate
    only looks at POST)."""
    return sorted({route.path for route in h.server.app.routes
                   if set(getattr(route, "methods", None) or ()) - {"GET", "HEAD"}})


def input_routes_in_app(h):
    """Every route that takes anything but GET and is not in NOT_INPUT_ROUTES:
    the ones that must be declared with @input_route."""
    return sorted(set(writing_routes(h)) - NOT_INPUT_ROUTES)


@contextlib.contextmanager
def halted(h, reason="page"):
    """Input halted through POST /session/halt for a with block, and lifted after
    it however the block ends."""
    status, body = h.api.post("/session/halt", {"reason": reason})
    expect(status == 200 and body.get("ok") is True and body.get("halted") is True,
           f"POST /session/halt: status {status}: {body}")
    try:
        yield body
    finally:
        h.server.resume_input()


@test("While input is halted every input route refuses with 423 before any input, and after Resume they work again")
def _(h):
    declared = input_routes_in_app(h)
    listed = sorted(h.server.INPUT_ROUTES)
    expect(declared == listed, f"neither @input_route nor in NOT_INPUT_ROUTES here: {sorted(set(declared) - set(listed))}; "
                               f"@input_route but not found: {sorted(set(listed) - set(declared))}")
    expect(NOT_INPUT_ROUTES <= set(writing_routes(h)),
           f"NOT_INPUT_ROUTES names routes the backend no longer has: {sorted(NOT_INPUT_ROUTES - set(writing_routes(h)))}")
    expect(sorted(INPUT_BODIES) == declared, f"INPUT_BODIES here needs a body for: {sorted(set(declared) - set(INPUT_BODIES))}")

    with halted(h) as state:
        expect(state.get("reasons") == ["page"] and state.get("by") == "the agent page" and isinstance(state.get("since"), str),
               f"POST /session/halt: {state}")
        h.inputs.clear()
        for path in declared:
            status, body = h.api.post(path, INPUT_BODIES[path])
            expect(status == 423 and body.get("ok") is False and body.get("halted") is True
                   and "Resume" in body.get("error", ""), f"{path} while halted: status {status}: {body}")
        expect(not h.inputs.calls, f"input reached while halted: {h.inputs.names()}")
        # A request without the token is refused for that, and learns nothing of the halt.
        status, body = h.api.post("/mouse/click", INPUT_BODIES["/mouse/click"], headers={TOKEN: None})
        expect(status == 401 and "halted" not in body, f"no token while halted: status {status}: {body}")
        # What sends no input still answers: the screen, the state, and letting the game run.
        for method, path, body in (("GET", "/screen/info", None), ("GET", "/session/state", None),
                                   ("POST", "/game/detach", {}), ("POST", "/log/append", {"session": "halt-check", "lines": ["x"]})):
            status, reply = h.api.request(method, path, body)
            expect(status == 200, f"{method} {path} while halted: status {status}: {reply}")
        status, reply = h.api.get("/session/state")
        expect(reply.get("halted") is True and reply.get("reasons") == ["page"], f"GET /session/state: {reply}")
        status, reply = h.api.get("/health", headers={TOKEN: None})
        expect(status == 200 and reply.get("halted") is True, f"GET /health while halted: status {status}: {reply}")

        status, reply = h.api.post("/session/resume", {})
        expect(status == 200 and reply.get("ok") is True and reply.get("halted") is False and reply.get("reasons") == []
               and reply.get("since") is None, f"POST /session/resume: status {status}: {reply}")
        h.inputs.clear()
        status, body = h.api.post("/mouse/click", INPUT_BODIES["/mouse/click"])
        expect(status == 200 and body.get("ok") is True and len(h.inputs.named("pyautogui.click")) == 1,
               f"a click after Resume: status {status}: {body}; {h.inputs.names()}")


@test("A halt lets go at once of every key held, from another request, and the hold under way stops within a step")
def _(h):
    for method, ids, patches in key_paths(h):
        with swapped(h.server, **patches):
            # The hold waits at its third step until the halt has been sent from
            # another request, as the page's Stop or a hotkey would send it.
            wait = h.server._wait
            third_step, go_on = threading.Event(), threading.Event()

            def blocking_wait(seconds):
                wait(seconds)
                if len(h.inputs.named("wait")) == 3:
                    third_step.set()
                    go_on.wait(10)

            result = {}
            holder = Api(h.api.base, h.api.headers)
            h.inputs.clear()
            with swapped(h.server, _wait=blocking_wait):
                thread = threading.Thread(target=lambda: result.update(
                    reply=holder.post("/keyboard/hold", {"key": "ctrl+a", "duration": 5})))
                thread.start()
                try:
                    expect(third_step.wait(10), f"{method}: the hold never reached its third step: {key_events(h)}")
                    status, halt = h.api.post("/session/halt", {"reason": "page"})
                    at_halt = key_events(h)
                finally:
                    go_on.set()
                    thread.join(10)
            h.server.resume_input()
            down = [("down", ids["ctrl"]), ("down", ids["a"])] + [("wait", 0.1)] * 3
            up = [("up", ids["a"]), ("up", ids["ctrl"])]
            # The halt itself let both keys go while the hold was still waiting...
            expect(status == 200 and at_halt == down + up and len(halt.get("letGo", {}).get("keys", [])) == 2,
                   f"{method}: when the halt answered: {at_halt}; {halt}")
            # ...and the hold, seeing the halt at its next step, stopped and let
            # them go again (a key-up for a key that is up does nothing).
            status, body = result.get("reply", (None, {}))
            expect(status == 200 and body.get("ok") is True and body.get("halted") is True and abs(body.get("held", 0) - 0.3) < 1e-6,
                   f"{method}: the hold's reply: {result}")
            expect(key_events(h) == down + up + up, f"{method}: {key_events(h)}")
            expect(not h.server._held, f"{method}: still listed as held: {h.server._held}")

    # The gamepad goes back to rest and a slowed game to normal speed.
    status, body = h.api.post("/gamepad/button", {"button": "a", "hold": 0.02})  # the pad exists from here on
    expect(body.get("ok") is True, f"gamepad button: {body}")
    client = sys.modules["xspeedhack"].Client(process_id=1234)
    with swapped(h.server, _speed_client=client):
        h.inputs.clear()
        with halted(h) as state:
            names = h.inputs.names()
    expect(names == ["vgamepad.reset", "vgamepad.update", "xspeedhack.set_speed"]
           and h.inputs.named("xspeedhack.set_speed")[0].args == (1.0,), f"on halt: {h.inputs.calls}")
    expect(state.get("letGo") == {"keys": [], "gamepad": True, "speed": True, "errors": []}, f"letGo: {state.get('letGo')}")


@test("A halt part-way through a pointer glide, a drag, clicks, a key press or typing stops the rest, and a drag lets its button go")
def _(h):
    def after_steps(n):
        return lambda: len(h.inputs.named("wait")) >= n

    # A one-second glide goes in pyautogui's own 0.05 s steps, ending on the spot...
    status, body = h.api.post("/mouse/move", {"x": 1000, "y": 500, "duration": 1})
    moves = [c.args for c in h.inputs.named("pyautogui.moveTo")]
    steps = [c.args[0] for c in h.inputs.named("wait")]
    expect(body.get("ok") is True and len(moves) == 20 and moves[-1] == (1000, 500) and abs(sum(steps) - 1) < 1e-6,
           f"a 1 s glide: {body}; {len(moves)} moves ending {moves[-1:]}, waited {sum(steps)}")
    # ...is cut to five seconds...
    h.inputs.clear()
    h.api.post("/mouse/move", {"x": 1000, "y": 500, "duration": 600})
    expect(abs(sum(c.args[0] for c in h.inputs.named("wait")) - h.server.MOUSE_MOVE_MAX_S) < 1e-6,
           f"a 600 s glide waited {sum(c.args[0] for c in h.inputs.named('wait'))} s")
    # ...and stops where it was when input is halted.
    h.inputs.clear()
    with swapped(h.server, _input_halted=after_steps(5)):
        status, body = h.api.post("/mouse/move", {"x": 1000, "y": 500, "duration": 1})
    moves = [c.args for c in h.inputs.named("pyautogui.moveTo")]
    expect(body.get("ok") is False and body.get("halted") is True and len(moves) == 4 and moves[-1] != (1000, 500),
           f"a glide halted after 5 steps: {body}; moves {moves}")

    # A drag halted part-way: the halt lets the button go, the glide stops, and
    # the drag lets it go again.
    wait = h.server._wait

    def halt_at_third_step(seconds):
        wait(seconds)
        if len(h.inputs.named("wait")) == 3:
            h.server.halt_input("page", "the check")

    h.inputs.clear()
    with swapped(h.server, _wait=halt_at_third_step):
        status, body = h.api.post("/mouse/drag", {"x1": 100, "y1": 100, "x2": 300, "y2": 300, "duration": 1})
    h.server.resume_input()
    calls = [c.name.split(".")[-1] for c in h.inputs.calls if c.name.startswith("pyautogui.") and c.name != "pyautogui.position"]
    expect(body.get("ok") is False and body.get("halted") is True, f"drag halted: {body}")
    expect(calls == ["moveTo", "mouseDown", "moveTo", "moveTo", "mouseUp", "mouseUp"], f"drag halted: {calls}")
    expect(not h.server._held, f"still listed as held: {h.server._held}")

    # A triple click halted after the first click makes no more.
    h.inputs.clear()
    with swapped(h.server, _input_halted=after_steps(1)):
        status, body = h.api.post("/mouse/click", {"x": 100, "y": 100, "clicks": 3, "move_duration": 0})
    expect(body.get("ok") is False and body.get("halted") is True and body.get("clicked") == 1
           and len(h.inputs.named("pyautogui.click")) == 1, f"clicks halted: {body}; {h.inputs.names()}")
    h.inputs.clear()
    status, body = h.api.post("/mouse/click", {"x": 100, "y": 100, "clicks": 3, "move_duration": 0})
    expect(body.get("ok") is True and len(h.inputs.named("pyautogui.click")) == 3
           and [c.args[0] for c in h.inputs.named("wait")] == [h.server.CLICK_INTERVAL_S] * 2, f"a triple click: {h.inputs.calls}")

    # A key press is a short hold: halted part-way, it lets the key go at once.
    for method, ids, patches in key_paths(h):
        h.inputs.clear()
        with swapped(h.server, _input_halted=after_steps(2), **patches):
            status, body = h.api.post("/keyboard/press", {"key": "a", "hold": 1})
        expect(body.get("ok") is False and body.get("halted") is True and body.get("method") == method,
               f"{method}, a press halted: {body}")
        expect(key_events(h) == [("down", ids["a"]), ("wait", 0.1), ("wait", 0.1), ("up", ids["a"])],
               f"{method}, a press halted: {key_events(h)}")

    # Typing goes a piece at a time (two characters at 0.05 s apart); halted
    # after the second piece, the rest is not typed, and the reply says how much was.
    h.inputs.clear()
    with swapped(h.server, _input_halted=lambda: len(h.inputs.named("pyautogui.typewrite")) >= 2):
        status, body = h.api.post("/keyboard/type", {"text": "abcdefghij", "interval": 0.05})
    typed = [c.args[0] for c in h.inputs.named("pyautogui.typewrite")]
    expect(body.get("ok") is False and body.get("halted") is True and body.get("typed") == 4
           and body.get("limit", {}).get("applied") == 10 and typed == ["ab", "cd"], f"typing halted: {body}; typed {typed}")


@test("A stick, a trigger or the game speed a request set just as input was halted is put back, not left for the halt")
def _(h):
    def halted_after(n):
        """No to the first n askers (HaltGate, then the route), yes from then on:
        a halt that lands while the route is setting the value."""
        answers = iter([False] * n)
        return lambda: next(answers, True)

    for path, body, setter, moved, rest in (
            ("/gamepad/stick", {"stick": "left", "x": 1, "y": 0, "duration": 0}, "vgamepad.left_joystick_float",
             {"x_value_float": 1.0, "y_value_float": 0.0}, {"x_value_float": 0.0, "y_value_float": 0.0}),
            ("/gamepad/trigger", {"trigger": "right", "value": 1, "duration": 0}, "vgamepad.right_trigger_float",
             {"value_float": 1.0}, {"value_float": 0.0})):
        # With duration 0 it stays where it was put...
        h.inputs.clear()
        status, reply = h.api.post(path, body)
        sets = [c.kwargs for c in h.inputs.named(setter)]
        expect(reply.get("ok") is True and reply.get("halted") is False and sets == [moved], f"{path}: {reply}; {sets}")
        # ...unless input was halted meanwhile: the halt's gamepad reset may have
        # come first, so the route puts it back to rest itself.
        h.inputs.clear()
        with swapped(h.server, _input_halted=halted_after(2)):
            status, reply = h.api.post(path, body)
        sets = [c.kwargs for c in h.inputs.named(setter)]
        expect(status == 200 and reply.get("ok") is True and reply.get("halted") is True and reply.get("held") == 0.0
               and sets == [moved, rest], f"{path} halted while set: status {status}: {reply}; {sets}")

    client = sys.modules["xspeedhack"].Client(process_id=1234)
    with swapped(h.server, _speed_client=client, SPEEDHACK_AVAILABLE=True):
        h.inputs.clear()
        status, reply = h.api.post("/game/speed", {"speed": 0})
        speeds = [c.args[0] for c in h.inputs.named("xspeedhack.set_speed")]
        expect(reply == {"ok": True, "speed": 0} and speeds == [0.0], f"pause-to-think's speed 0: {reply}; {speeds}")
        # Pause-to-think's speed 0, halted as it went out: the game is set back
        # to normal speed, or it would stay frozen for the whole halt.
        h.inputs.clear()
        with swapped(h.server, _input_halted=halted_after(2)):
            status, reply = h.api.post("/game/speed", {"speed": 0})
        speeds = [c.args[0] for c in h.inputs.named("xspeedhack.set_speed")]
        expect(status == 200 and reply.get("ok") is False and reply.get("halted") is True and speeds == [0.0, 1.0],
               f"speed 0 halted as it went out: status {status}: {reply}; speeds {speeds}")
        # Halted after the gate but before the call: nothing is sent at all.
        h.inputs.clear()
        with swapped(h.server, _input_halted=halted_after_gate()):
            status, reply = h.api.post("/game/speed", {"speed": 0})
        expect(reply.get("halted") is True and not h.inputs.named("xspeedhack.set_speed"),
               f"speed 0 halted after the gate: {reply}; {h.inputs.calls}")


@test("The agent never presses a kill-switch chord: /keyboard/press and /keyboard/hold refuse one before any input")
def _(h):
    # Windows takes an injected chord for the operator's, so the agent pressing
    # one (told to by the screen, say) would halt its own input until Resume.
    chords = ("ctrl+alt+shift+h", "Ctrl + Alt + Shift + H", "h+shift+alt+ctrl", "ctrlright+altleft+shiftright+h",
              "altright+shift+h", "ctrl+alt+pause", "ctrl+alt+break", "alt+ctrl+pause", "ctrl+alt+shift+pause")
    for method, ids, patches in key_paths(h):
        with swapped(h.server, **patches):
            for key in chords:
                for path, body in (("/keyboard/press", {"key": key, "hold": 0}),
                                   ("/keyboard/hold", {"key": key, "duration": 0.1})):
                    h.inputs.clear()
                    status, reply = h.api.post(path, body)
                    expect(status == 200 and reply.get("ok") is False and "kill switch" in reply.get("error", "")
                           and not h.inputs.calls, f"{method}, {path} {key!r}: status {status}: {reply}; {h.inputs.names()}")
            # Near misses are keys like any other.
            for key in ("ctrl+alt+h", "ctrl+shift+h", "alt+shift+h", "ctrl+alt+a", "ctrl+pause", "shift+pause", "h"):
                h.inputs.clear()
                status, reply = h.api.post("/keyboard/press", {"key": key, "hold": 0})
                expect(reply.get("ok") is True and h.inputs.calls, f"{method}, {key!r}: {reply}; {h.inputs.names()}")

    # A chord made with keys another request is holding down is refused too.
    held_ways = [("key", ("ctrl", "alt"))]
    if h.server.SENDINPUT_OK:
        held_ways.insert(0, ("scan", (0x1D, 0x38)))
    for kind, held in held_ways:
        try:
            for key in held:
                h.server._pressing(kind, key, lambda: None)
            h.inputs.clear()
            status, reply = h.api.post("/keyboard/press", {"key": "shift+h", "hold": 0})
            expect(reply.get("ok") is False and "Ctrl+Alt+Shift+H" in reply.get("error", "") and not h.inputs.calls,
                   f"shift+h while {kind} {held} are held: {reply}; {h.inputs.names()}")
            status, reply = h.api.post("/keyboard/press", {"key": "h", "hold": 0})
            expect(reply.get("ok") is True, f"h while {kind} {held} are held: {reply}")
        finally:
            for key in held:
                h.server._let_go(kind, key)


@test("The kill-switch hotkeys: two chords, without repeat, that halt input and never resume it; none registered in the checks")
def _(h):
    s = h.server
    expect([name for name, _, _ in s.HALT_HOTKEYS] == ["Ctrl+Alt+Pause", "Ctrl+Alt+Shift+H"], f"chords: {s.HALT_HOTKEYS}")
    before = {k: list(v) for k, v in s.HOTKEYS.items()}
    try:
        # Registering a global hotkey is a side effect on whatever machine runs
        # the checks, so the backend skips it under AGENT_TEST=1.
        got = s.start_halt_hotkeys()
        expect(got["registered"] == [] and "AGENT_TEST" in " ".join(got["problems"])
               and not [t for t in threading.enumerate() if t.name == "kill-switch-hotkeys"], f"under AGENT_TEST: {got}")

        class FakeWindows:
            """RegisterHotKey and the message loop, stood in for."""

            def __init__(self, taken=(), pressed=()):
                self.registered, self.taken, self.pressed = [], set(taken), list(pressed)

            def register(self, hotkey_id, modifiers, vk):
                self.registered.append((hotkey_id, modifiers, vk))
                return s.ERROR_HOTKEY_ALREADY_REGISTERED if vk in self.taken else 0

            def next_hotkey(self):
                return self.pressed.pop(0) if self.pressed else None

        # Ctrl+Alt+Pause is registered as Break (what Pause sends with Ctrl held,
        # so the one that counts) and as Pause, and with Shift as well (the chord
        # pressed while the agent holds Shift); Ctrl+Alt+Shift+H as H; all
        # without key repeat. Pressing the chord (as Break, id 1, twice) halts
        # input, and twice is harmless.
        fake = FakeWindows(pressed=[1, 1])
        ready = threading.Event()
        s._hotkey_loop(ready, fake)
        state = s.halt_state()
        ctrl_alt = s.MOD_CONTROL | s.MOD_ALT | s.MOD_NOREPEAT
        shift = s.MOD_SHIFT
        expect(ready.is_set() and sorted((m, vk) for _, m, vk in fake.registered)
               == sorted([(ctrl_alt, 0x13), (ctrl_alt, 0x03), (ctrl_alt | shift, 0x13), (ctrl_alt | shift, 0x03),
                          (ctrl_alt | shift, ord("H"))]), f"registered: {fake.registered}")
        expect(s.HOTKEYS == {"registered": ["Ctrl+Alt+Pause", "Ctrl+Alt+Shift+H"], "problems": []}, f"HOTKEYS: {s.HOTKEYS}")
        expect(state["halted"] is True and state["reasons"] == ["hotkey"] and state["by"] == "Ctrl+Alt+Pause", f"after the chord: {state}")
        status, body = h.api.get("/health", headers={TOKEN: None})
        expect(body == {"status": "ok", "halted": True, "hotkeys": ["Ctrl+Alt+Pause", "Ctrl+Alt+Shift+H"]}, f"/health: {body}")
        s.resume_input()

        # A chord another program holds is reported, and the other still works.
        fake = FakeWindows(taken={ord("H")}, pressed=[5])  # 5 is the H chord's id, not registered
        s._hotkey_loop(threading.Event(), fake)
        expect(s.HOTKEYS == {"registered": ["Ctrl+Alt+Pause"], "problems": ["Ctrl+Alt+Shift+H is taken by another program"]}
               and not s._input_halted(), f"one chord taken: {s.HOTKEYS}; halted {s._input_halted()}")
        # Registered only with Shift added is not the chord as people press it.
        fake = FakeWindows(taken={0x13, 0x03})
        fake.register = lambda hotkey_id, modifiers, vk: (
            fake.registered.append((hotkey_id, modifiers, vk))
            or (s.ERROR_HOTKEY_ALREADY_REGISTERED if vk in (0x13, 0x03) and not modifiers & s.MOD_SHIFT else 0))
        s._hotkey_loop(threading.Event(), fake)
        expect(s.HOTKEYS == {"registered": ["Ctrl+Alt+Shift+H"], "problems": ["Ctrl+Alt+Pause is taken by another program"]},
               f"Ctrl+Alt+Pause taken, Ctrl+Alt+Shift+Pause free: {s.HOTKEYS}")
        # Only Ctrl+Alt+Break taken: Pause itself registered with Ctrl+Alt, but
        # most keyboards never send Pause with Ctrl down, so the chord is not
        # named as working. From a keyboard that does send it (id 2), it still halts.
        fake = FakeWindows(pressed=[2])
        fake.register = lambda hotkey_id, modifiers, vk: (
            fake.registered.append((hotkey_id, modifiers, vk))
            or (s.ERROR_HOTKEY_ALREADY_REGISTERED if vk == 0x03 and not modifiers & s.MOD_SHIFT else 0))
        s._hotkey_loop(threading.Event(), fake)
        expect(s.HOTKEYS == {"registered": ["Ctrl+Alt+Shift+H"], "problems": ["Ctrl+Alt+Pause is taken by another program"]}
               and (2, s.MOD_CONTROL | s.MOD_ALT | s.MOD_NOREPEAT, 0x13) in fake.registered,
               f"Ctrl+Alt+Break taken, Ctrl+Alt+Pause free: {s.HOTKEYS}; {fake.registered}")
        expect(s._input_halted() and s.halt_state()["by"] == "Ctrl+Alt+Pause", f"Pause pressed with Ctrl+Alt: {s.halt_state()}")
        s.resume_input()

        # The handler the thread calls halts, and pressing a chord again while
        # halted does not resume.
        for _ in range(2):
            s._on_hotkey("Ctrl+Alt+Shift+H")
            expect(s._input_halted() and s.halt_state()["by"] == "Ctrl+Alt+Shift+H", f"after the handler: {s.halt_state()}")
    finally:
        s.HOTKEYS.update(before)
    expect(not [c for c in h.inputs.calls if c.name.startswith("user32.")], f"reached Windows: {h.inputs.names()}")


@test("Stop's halt is lifted by Stop's own resume, a hotkey's only by Resume, and only the page's reasons are accepted")
def _(h):
    status, body = h.api.post("/session/halt", {"reason": "stop"})
    expect(status == 200 and body.get("reasons") == ["stop"] and body.get("by") == "■ Stop on the agent page", f"Stop's halt: {body}")
    status, body = h.api.post("/session/resume", {"reason": "stop"})
    expect(body.get("halted") is False, f"Stop's own resume: {body}")

    # A hotkey pressed while Stop's halt is on keeps input halted when the run ends.
    h.api.post("/session/halt", {"reason": "stop"})
    since = h.server.halt_state()["since"]
    h.server._on_hotkey("Ctrl+Alt+Pause")
    status, body = h.api.post("/session/resume", {"reason": "stop"})
    expect(body.get("halted") is True and body.get("reasons") == ["hotkey"] and body.get("by") == "Ctrl+Alt+Pause"
           and body.get("since") == since, f"Stop's resume after a hotkey: {body}")
    status, body = h.api.post("/mouse/move", INPUT_BODIES["/mouse/move"])
    expect(status == 423, f"still halted: status {status}: {body}")
    status, body = h.api.post("/session/resume", {})
    expect(body.get("halted") is False and body.get("reasons") == [], f"Resume: {body}")

    # Stop pressed after a hotkey: the page is still told the hotkey halted input,
    # since that is the halt that stays.
    h.server._on_hotkey("Ctrl+Alt+Shift+H")
    status, body = h.api.post("/session/halt", {"reason": "stop"})
    expect(body.get("reasons") == ["hotkey", "stop"] and body.get("by") == "Ctrl+Alt+Shift+H", f"Stop after a hotkey: {body}")
    h.server.resume_input()

    # Only the hotkey thread halts as a hotkey, and there is no reason to resume
    # that the page does not have.
    for path, body in (("/session/halt", {"reason": "hotkey"}), ("/session/halt", {"reason": "anything"}),
                       ("/session/resume", {"reason": "hotkey"})):
        status, reply = h.api.post(path, body)
        expect(status == 422, f"{path} {body}: status {status}: {reply}")
    expect(not h.server._input_halted(), "a refused request halted input")


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


# ── Ollama relay ─────────────────────────────────────────────────────────────
# The backend's _ollama_open, through which every request to Ollama goes, is
# replaced for these, so no request leaves the process: no Ollama is needed, and
# none is called. The one exception serves its own stand-in on a free local port.
#
# The relay used to send each request to whatever base_url the request named and
# hand back the reply, which let anything that reached the backend use it as a
# proxy into the LAN. It now sends only to the server chosen at startup.

def with_ollama(h, respond, call):
    """Run `call()` (a request to the backend) while the backend's requests to
    Ollama are answered by `respond(req)`: bytes for a reply body, or an
    exception to raise. Returns call's (status, body) and what was asked."""
    asked = []

    def fake_open(req, timeout=None):
        asked.append({"url": req.full_url, "method": req.get_method(), "timeout": timeout, "data": req.data})
        answer = respond(req)
        if isinstance(answer, BaseException):
            raise answer
        return io.BytesIO(answer)

    before = h.server._ollama_open
    h.server._ollama_open = fake_open
    try:
        status, body = call()
    finally:
        h.server._ollama_open = before
    return status, body, asked


def relay_through(h, failure):
    """POST /llm/ollama while every request to Ollama raises `failure`."""
    return with_ollama(h, lambda req: failure, lambda: h.api.post("/llm/ollama", {
        "payload": {"model": "test-model"}, "timeout": 600,
    }))


@contextlib.contextmanager
def ollama_server(h, base, source="agent-config.json", error=None):
    """The backend relaying to `base` (None with `error`: an unusable address)
    for the length of a with block, as if it had started that way."""
    before = h.server.OLLAMA_SERVER
    h.server.OLLAMA_SERVER = h.server.OllamaServer(base, source, error)
    try:
        yield
    finally:
        h.server.OLLAMA_SERVER = before


ANSWER = json.dumps({"choices": [{"message": {"role": "assistant", "content": "OK"}, "finish_reason": "stop"}]}).encode()


@test("POST /llm/ollama sends only to the configured Ollama server, whatever base_url a request names")
def _(h):
    chat = TEST_OLLAMA_BASE + "/v1/chat/completions"
    for label, extra in (("no base_url", {}),
                         ("a LAN address", {"base_url": "http://192.168.1.1:80"}),
                         ("the cloud metadata address", {"base_url": "http://169.254.169.254/latest/meta-data"}),
                         ("a file", {"base_url": "file:///C:/Windows/win.ini"}),
                         ("not even text", {"base_url": 5})):
        status, body, asked = with_ollama(h, lambda req: ANSWER, lambda: h.api.post("/llm/ollama", {
            "payload": {"model": "test-model", "messages": []}, "timeout": 600, **extra}))
        expect(status == 200 and body.get("ok") is True and body["body"]["choices"][0]["message"]["content"] == "OK",
               f"{label}: status {status}: {body}")
        expect([(a["url"], a["method"]) for a in asked] == [(chat, "POST")], f"{label}: asked {asked}")
        expect(json.loads(asked[0]["data"]) == {"model": "test-model", "messages": []},
               f"{label}: sent something other than the payload: {asked[0]['data']!r}")
    # The timeout the page asks for, held between 30 s and 30 minutes.
    for given, used in ((600, 600), (5, 30), (99999, 1800)):
        status, body, asked = with_ollama(h, lambda req: ANSWER, lambda: h.api.post("/llm/ollama", {
            "payload": {"model": "test-model"}, "timeout": given}))
        expect(len(asked) == 1 and asked[0]["timeout"] == used, f"timeout {given}: urlopen got {asked}")
    # A server with a path prefix (behind a reverse proxy) keeps it.
    with ollama_server(h, "https://ollama.example:8443/prefix"):
        status, body, asked = with_ollama(h, lambda req: ANSWER, lambda: h.api.post("/llm/ollama", {
            "payload": {}, "base_url": TEST_OLLAMA_BASE}))
    expect([a["url"] for a in asked] == ["https://ollama.example:8443/prefix/v1/chat/completions"], f"asked {asked}")
    expect(not h.inputs.calls, f"the relay touched input: {h.inputs.names()}")


@test("The relay refuses every request, reaching no server, while its configured address is unusable")
def _(h):
    why = "ollamaBase in agent-config.json is not a usable Ollama address: 'ftp://x' does not start with http:// or https://"
    with ollama_server(h, None, error=why):
        relay = with_ollama(h, lambda req: ANSWER, lambda: h.api.post("/llm/ollama", {"payload": {}}))
        tags = with_ollama(h, lambda req: ANSWER, lambda: h.api.get("/llm/ollama/tags"))
        status, caps = h.api.get("/capabilities")
    for label, (status, body, asked) in (("POST /llm/ollama", relay), ("GET /llm/ollama/tags", tags)):
        # A {"detail"} refusal, which the page ends the session on at once with
        # this message, rather than waiting fifteen minutes for a model it
        # cannot reach.
        expect(status == 503 and body.get("ok") is False and why in str(body.get("detail"))
               and "restart" in str(body.get("detail")), f"{label}: status {status}: {body}")
        expect(not asked, f"{label}: a request went out anyway: {asked}")
    expect(caps["ollama"]["base"] is None and caps["ollama"]["error"] == why, f"/capabilities: {caps}")


@test("The relay does not follow a redirect away from the configured Ollama server")
def _(h):
    import http.server

    hits = {"ollama": [], "elsewhere": []}

    def serve(name, answer):
        class Handler(http.server.BaseHTTPRequestHandler):
            def handle_one(self):
                hits[name].append((self.command, self.path))
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                status, headers, body = answer(self)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = handle_one

            def log_message(self, *args):
                pass

        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        return httpd, f"http://127.0.0.1:{httpd.server_address[1]}"

    elsewhere, elsewhere_url = serve("elsewhere", lambda r: (200, {"Content-Type": "application/json"},
                                                            json.dumps({"models": [], "choices": []}).encode()))
    moved = {"POST": 307, "GET": 302}
    ollama, ollama_url = serve("ollama", lambda r: (moved[r.command], {"Location": elsewhere_url + r.path}, b""))
    no_proxy = urllib.request.ProxyHandler({})  # these two servers are local, whatever this PC's proxy is
    before = h.server._ollama_opener
    try:
        # The stand-in redirect is one that urllib follows unless told not to.
        with urllib.request.build_opener(no_proxy).open(ollama_url + "/api/tags", timeout=10) as resp:
            expect(resp.status == 200 and len(hits["elsewhere"]) == 1, f"the test's redirect was not followed: {hits}")
        hits["ollama"].clear()
        hits["elsewhere"].clear()

        expect(any(isinstance(x, h.server._NoRedirects) for x in before.handlers),
               "the backend's opener for Ollama does not refuse redirects")
        h.server._ollama_opener = urllib.request.build_opener(no_proxy, h.server._NoRedirects)
        h.server._ollama_open = OLLAMA_OPEN["real"]
        with ollama_server(h, ollama_url):
            relay_status, relay = h.api.post("/llm/ollama", {"payload": {"model": "test-model"}, "timeout": 30})
            tags_status, tags = h.api.get("/llm/ollama/tags")
    finally:
        h.server._ollama_opener = before
        h.server._ollama_open = no_ollama_in_checks(h.inputs)
        for httpd in (ollama, elsewhere):
            httpd.shutdown()
            httpd.server_close()
    expect(hits["ollama"] == [("POST", "/v1/chat/completions"), ("GET", "/api/tags")], f"the configured server saw {hits['ollama']}")
    expect(not hits["elsewhere"], f"a request followed the redirect: {hits['elsewhere']}")
    expect(relay_status == 502 and "redirect" in str(relay.get("detail")) and elsewhere_url in str(relay.get("detail")),
           f"relay: status {relay_status}: {relay}")
    expect(tags_status == 200 and tags.get("ok") is False and tags.get("status") == 302 and "redirect" in tags.get("error", ""),
           f"tags: status {tags_status}: {tags}")


@test("GET /llm/ollama/tags lists the models on the configured server, and asks nowhere else")
def _(h):
    listing = {"models": [
        {"name": "qwen2.5vl:3b", "model": "qwen2.5vl:3b", "size": 3200000000, "digest": "abc",
         "modified_at": "2026-09-01T10:00:00Z",
         "details": {"family": "qwen25vl", "families": ["qwen25vl"], "parameter_size": "3.8B", "quantization_level": "Q4_K_M"}},
        {"name": "gemma3:4b"},
        {"not": "a model"},
    ]}
    status, body, asked = with_ollama(h, lambda req: json.dumps(listing).encode(),
                                      lambda: h.api.get("/llm/ollama/tags?base_url=http://169.254.169.254"))
    expect([(a["url"], a["method"], a["timeout"]) for a in asked]
           == [(TEST_OLLAMA_BASE + "/api/tags", "GET", h.server.OLLAMA_TAGS_TIMEOUT_S)], f"asked {asked}")
    expect(status == 200 and body.get("ok") is True and body.get("base") == TEST_OLLAMA_BASE, f"status {status}: {body}")
    models = body.get("models") or []
    expect([m["name"] for m in models] == ["qwen2.5vl:3b", "gemma3:4b"], f"models: {models}")
    expect(models and models[0] == {"name": "qwen2.5vl:3b", "size": 3200000000, "modifiedAt": "2026-09-01T10:00:00Z",
                                    "family": "qwen25vl", "families": ["qwen25vl"], "parameterSize": "3.8B",
                                    "quantization": "Q4_K_M"}, f"first model: {models[:1]}")

    for label, answer, check in (
        ("Ollama not running", urllib.error.URLError(ConnectionRefusedError(10061, "refused")),
         lambda b: b.get("status") == 0 and b.get("timedOut") is False),
        ("no answer in time", TimeoutError("timed out"), lambda b: b.get("status") == 0 and b.get("timedOut") is True),
        ("a server error", urllib.error.HTTPError(TEST_OLLAMA_BASE + "/api/tags", 500, "Server Error", None,
                                                  io.BytesIO(b"boom")), lambda b: b.get("status") == 500 and "boom" in b.get("error", "")),
        ("something that is not Ollama", b"<html>router login</html>", lambda b: "Ollama model list" in b.get("error", "")),
    ):
        status, body, asked = with_ollama(h, lambda req: answer, lambda: h.api.get("/llm/ollama/tags"))
        expect(status == 200 and body.get("ok") is False and body.get("base") == TEST_OLLAMA_BASE and check(body),
               f"{label}: status {status}: {body}")
    expect(not h.inputs.calls, f"listing models touched input: {h.inputs.names()}")


@test("POST /config/ollama-base refuses file:, ftp:, a missing host and non-URL input, and writes nothing")
def _(h):
    config = Path(h.server.CONFIG_FILE)
    config.unlink(missing_ok=True)
    bad = ["file:///C:/Windows/win.ini", "file://server/share", "ftp://192.168.1.50/", "javascript:alert(1)",
           "http://", "https://", "http:///v1", "http://:11434", "not a url", "192.168.1.50:11434", "localhost:11434",
           "", "   ", "http://user:pass@192.168.1.50:11434", "http://192.168.1.50:99999", "http://192.168.1.50:port",
           "http://192.168.1.50:11434/?next=http://evil.example", "http://192.168.1.50:11434#x", "http://ho st:11434",
           "http://[::1", "http://evil!.example", "http://192.168.1.50:11434/v1/chat/completions",
           "http://192.168.1.50:11434/api", "http://192.168.1.50\n.evil.example:11434", "http://" + "a" * 300,
           # Accepted before, then failing every request: port 0, an empty port,
           # and characters urllib cannot put in a request line.
           "http://192.168.1.50:0", "http://192.168.1.50:", "http://[::1]:", "http://ollama-box:11434/modèles",
           "http://bücher.example:11434", "http://192.168.1.50:11434/pre@fix"]
    for value in bad:
        status, body = h.api.post("/config/ollama-base", {"base_url": value})
        expect(status == 422 and body.get("ok") is False and body.get("error"), f"{value!r}: status {status}: {body}")

    # A refusal is printed, returned to the page and logged: it never repeats a
    # password, however the address around it is written.
    secret = "S3cretTok"
    for value in (f"https://agent:{secret}@ollama.example", f"http://agent:{secret}@192.168.1.50:11434/",
                  f"http://agent:p@{secret}@192.168.1.50:11434", f"http://agent:{secret}/x@192.168.1.50:11434",
                  f"http://agent:{secret} x@192.168.1.50:11434", f"agent:{secret}@192.168.1.50:11434",
                  f"agent:{secret}//x@192.168.1.50:11434"):
        status, body = h.api.post("/config/ollama-base", {"base_url": value})
        chosen = h.server.choose_ollama_base({h.server.OLLAMA_BASE_ENV: value}, config)
        expect(status == 422 and secret not in json.dumps(body) and chosen.base is None and secret not in chosen.error,
               f"{value!r}: status {status}: {body}; at start: {chosen.error}")
    for value in (5, None, ["http://192.168.1.50:11434"]):
        status, body = h.api.post("/config/ollama-base", {"base_url": value})
        expect(status == 422, f"{value!r}: status {status}: {body}")
    status, body = h.api.post("/config/ollama-base", {})
    expect(status == 422, f"no base_url: status {status}: {body}")
    expect(not config.exists(), f"a refused address was written: {config.read_text(encoding='utf-8') if config.exists() else ''}")
    expect(h.server.OLLAMA_SERVER.base == TEST_OLLAMA_BASE, f"the running relay moved: {h.server.OLLAMA_SERVER}")

    # What is accepted, as it is saved.
    good = [("http://192.168.1.50:11434", "http://192.168.1.50:11434"),
            ("  HTTP://Ollama-Box:11434/  ", "http://Ollama-Box:11434"),
            ("https://ollama.example/prefix/", "https://ollama.example/prefix"),
            ("http://[::1]:11434", "http://[::1]:11434"),
            ("http://localhost", "http://localhost"),
            ("http://gpu_pc.lan:11434", "http://gpu_pc.lan:11434")]
    wrong = [(given, h.server.ollama_base_from(given), want) for given, want in good
             if h.server.ollama_base_from(given) != want]
    expect(not wrong, f"accepted addresses saved as: {wrong}")
    expect(not h.inputs.calls, f"saving touched input: {h.inputs.names()}")


@test("POST /config/ollama-base saves the address for the next start, and the running relay keeps its own")
def _(h):
    config = Path(h.server.CONFIG_FILE)
    config.write_text(json.dumps({"note": "kept", "ollamaBase": "http://10.0.0.1:11434"}), encoding="utf-8")
    lan = "http://192.168.1.50:11434"
    status, body = h.api.post("/config/ollama-base", {"base_url": f" HTTP://192.168.1.50:11434/ "})
    expect(status == 200 and body.get("ok") is True and body.get("saved") == lan and body.get("active") == TEST_OLLAMA_BASE
           and body.get("restartRequired") is True and body.get("overriddenBy") is None, f"status {status}: {body}")
    expect(json.loads(config.read_text(encoding="utf-8")) == {"note": "kept", "ollamaBase": lan},
           f"on disk: {config.read_text(encoding='utf-8')}")
    expect(sorted(p.name for p in config.parent.glob("agent-config.json*")) == ["agent-config.json"],
           f"left behind: {list(config.parent.glob('agent-config.json*'))}")

    # The relay keeps sending where it started until the backend restarts...
    expect(h.server.OLLAMA_SERVER.base == TEST_OLLAMA_BASE, f"the running relay moved: {h.server.OLLAMA_SERVER}")
    _, _, asked = with_ollama(h, lambda req: ANSWER, lambda: h.api.post("/llm/ollama", {"payload": {}}))
    expect([a["url"] for a in asked] == [TEST_OLLAMA_BASE + "/v1/chat/completions"], f"asked {asked}")
    status, caps = h.api.get("/capabilities")
    expect(caps.get("ollama") == {"base": TEST_OLLAMA_BASE, "source": "default", "error": None, "saved": lan},
           f"/capabilities: {caps.get('ollama')}")
    # ...and a restart picks the saved one up.
    expect(h.server.choose_ollama_base({}, config) == (lan, "agent-config.json", None),
           f"the next start would use {h.server.choose_ollama_base({}, config)}")

    status, body = h.api.post("/config/ollama-base", {"base_url": TEST_OLLAMA_BASE})
    expect(body.get("ok") is True and body.get("restartRequired") is False, f"saving the running address: {body}")
    with ollama_server(h, "http://10.0.0.9:11434", source="OLLAMA_BASE_URL"):
        status, body = h.api.post("/config/ollama-base", {"base_url": lan})
    expect(body.get("ok") is True and body.get("overriddenBy") == "OLLAMA_BASE_URL", f"with OLLAMA_BASE_URL set: {body}")

    # A file someone broke by hand is left for them to fix, not overwritten:
    # one that is not JSON, and one saved in a Windows code page, not UTF-8.
    for broken, says in ((b"{\"ollamaBase\": ", "not valid JSON"),
                         ("{\"note\": \"café\", \"ollamaBase\": \"http://10.0.0.1:11434\"}".encode("cp1252"), "not UTF-8")):
        config.write_bytes(broken)
        status, body = h.api.post("/config/ollama-base", {"base_url": lan})
        expect(status == 409 and body.get("ok") is False and "agent-config.json" in body.get("error", "")
               and says in body.get("error", ""), f"{broken!r}: status {status}: {body}")
        expect(config.read_bytes() == broken, f"a broken config file was overwritten: {config.read_bytes()!r}")
        status, caps = h.api.get("/capabilities")
        expect(status == 200 and caps.get("ollama", {}).get("saved") is None, f"{broken!r}: /capabilities: {status} {caps}")
    config.write_bytes(json.dumps({"note": "kept"}).encode("utf-16"))
    status, body = h.api.post("/config/ollama-base", {"base_url": lan})
    expect(status == 200 and json.loads(config.read_text(encoding="utf-8")) == {"note": "kept", "ollamaBase": lan},
           f"a UTF-16 file (PowerShell 5.1's >): status {status}: {body}; on disk: {config.read_bytes()[:80]!r}")
    config.unlink()


@test("The relay's server is OLLAMA_BASE_URL, else agent-config.json, else localhost, and never a fallback past a bad one")
def _(h):
    folder = Path(h.tmp) / "choose"
    folder.mkdir(exist_ok=True)
    config = folder / "agent-config.json"
    env = h.server.OLLAMA_BASE_ENV
    default = h.server.OLLAMA_DEFAULT_BASE
    expect(env == "OLLAMA_BASE_URL" and default == "http://localhost:11434", f"{env}, {default}")

    def write(content):
        config.unlink(missing_ok=True)
        if isinstance(content, bytes):
            config.write_bytes(content)
        elif content is not None:
            config.write_text(content if isinstance(content, str) else json.dumps(content), encoding="utf-8")

    lan = {"ollamaBase": "http://10.0.0.5:11434"}
    cases = [
        ("nothing set", {}, None, (default, "default", None)),
        ("an empty config", {}, {}, (default, "default", None)),
        ("a blank ollamaBase", {}, {"ollamaBase": "  "}, (default, "default", None)),
        ("the config", {}, lan, ("http://10.0.0.5:11434", "agent-config.json", None)),
        ("the config, with a byte-order mark", {}, b"\xef\xbb\xbf" + json.dumps(lan).encode(), ("http://10.0.0.5:11434", "agent-config.json", None)),
        # What `echo ... > agent-config.json` writes in Windows PowerShell 5.1.
        ("the config in UTF-16 (little-endian, with its mark)", {}, json.dumps(lan).encode("utf-16"), ("http://10.0.0.5:11434", "agent-config.json", None)),
        ("the config in UTF-16 (big-endian, with its mark)", {}, b"\xfe\xff" + json.dumps(lan).encode("utf-16-be"), ("http://10.0.0.5:11434", "agent-config.json", None)),
        ("the environment over the config", {env: " http://10.0.0.9:11434/ "}, lan, ("http://10.0.0.9:11434", env, None)),
        ("a blank environment variable is not set", {env: "  "}, lan, ("http://10.0.0.5:11434", "agent-config.json", None)),
    ]
    unusable = [
        ("an environment value that is not an address", {env: "10.0.0.9:11434"}, lan, env, env),
        ("a file: address in the config", {}, {"ollamaBase": "file:///etc/passwd"}, "agent-config.json", "ollamaBase in agent-config.json"),
        ("a config that is not JSON", {}, "{broken", "agent-config.json", "not valid JSON"),
        ("a config that is not an object", {}, "[1, 2]", "agent-config.json", "JSON object"),
        ("an ollamaBase that is not text", {}, {"ollamaBase": 11434}, "agent-config.json", "must be text"),
        # Each of these used to raise out of the import and stop the whole backend.
        ("a config saved in a Windows code page", {}, "{\"note\": \"café\", \"ollamaBase\": \"http://10.0.0.5:11434\"}".encode("cp1252"),
         "agent-config.json", "not UTF-8"),
        ("a config that is not text at all", {}, b"\x80\x81\x82\xfe", "agent-config.json", "not UTF-8"),
        ("a config nested too deep to read", {}, "[" * 200_000, "agent-config.json", "not valid JSON"),
        ("UTF-16 without its mark", {}, json.dumps(lan).encode("utf-16-le"), "agent-config.json", "not valid JSON"),
    ]
    wrong = []
    for label, environ, content, want in cases:
        write(content)
        got = h.server.choose_ollama_base(environ, config)
        if tuple(got) != want:
            wrong.append(f"{label}: {tuple(got)}, wanted {want}")
    for label, environ, content, source, says in unusable:
        write(content)
        got = h.server.choose_ollama_base(environ, config)
        # No quiet fall back to localhost: the model's requests would go to a
        # server the operator did not choose, and fail there less clearly.
        if got.base is not None or got.source != source or says not in (got.error or ""):
            wrong.append(f"{label}: {tuple(got)}")
    expect(not wrong, "; ".join(wrong))

    # And a problem nobody foresaw costs the relay its server, not the backend
    # its start: the choice runs on import, before any route exists.
    real_choose = h.server.choose_ollama_base

    def unforeseen(environ, config_file):
        raise RuntimeError("something nobody foresaw")

    h.server.choose_ollama_base = unforeseen
    try:
        got = h.server._startup_ollama_server()
    finally:
        h.server.choose_ollama_base = real_choose
    expect(got.base is None and "something nobody foresaw" in (got.error or ""), f"at start: {tuple(got)}")


@test("POST /llm/ollama says when Ollama ran out of time, apart from other failures")
def _(h):
    # The page reads timedOut as a deadline, which it does not retry at once, and
    # anything else with status 0 as a dropped connection, which it does.
    cases = [
        ("reading the reply timed out", TimeoutError("timed out"), 0, True),
        ("connecting timed out", urllib.error.URLError(TimeoutError("timed out")), 0, True),
        ("connection refused", urllib.error.URLError(ConnectionRefusedError(10061, "refused")), 0, False),
        ("connection dropped", ConnectionResetError(10054, "reset"), 0, False),
        ("Ollama refused the request", urllib.error.HTTPError(
            TEST_OLLAMA_BASE + "/v1/chat/completions", 400, "Bad Request", None,
            io.BytesIO(b'{"error":"model does not support tools"}')), 400, False),
    ]
    for label, failure, want_status, want_timed_out in cases:
        status, body, asked = relay_through(h, failure)
        expect(len(asked) == 1, f"{label}: urlopen was asked {len(asked)} times: {asked}")
        expect(asked[0]["timeout"] == 600 and asked[0]["url"] == TEST_OLLAMA_BASE + "/v1/chat/completions",
               f"{label}: the relay did not pass the page's timeout on, to the configured server: {asked}")
        expect(status == 200 and body.get("ok") is False and body.get("status") == want_status,
               f"{label}: status {status}: {body}")
        expect(bool(body.get("timedOut")) is want_timed_out, f"{label}: timedOut should be {want_timed_out}: {body}")
    expect("does not support tools" in body.get("error", ""), f"Ollama's own words were lost: {body}")
    expect(not h.inputs.calls, f"the relay touched input: {h.inputs.names()}")


# ── Run ──────────────────────────────────────────────────────────────────────

def fresh_input_state(server):
    """Each test starts with input not halted and nothing held, whatever the one
    before it left behind (a check that failed part-way can leave either)."""
    if hasattr(server, "resume_input"):
        server.resume_input()
    if hasattr(server, "_held"):
        server._held.clear()


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
            uv, thread, port = start_server(server.app, getattr(server, "claim_port", None))
        except Exception:
            # Most likely a startup hook added to agent_server that raises.
            print_raised("server starts")
            return 1
        try:
            for name, fn in selected:
                fresh_input_state(server)
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
