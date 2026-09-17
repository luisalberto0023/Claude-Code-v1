"""
Game Agent Backend Server
─────────────────────────
Exposes a local HTTP API that the Vite frontend calls to perform
real OS-level mouse and keyboard actions via pyautogui.

Works on: Windows 10/11, macOS, Linux
Run:      python agent_server.py
Requires: pip install fastapi uvicorn pyautogui pillow pyperclip
"""

import sys
import time
import platform
import json
import math
import re
import datetime
import hmac
import ipaddress
import os
import secrets
import socket
from pathlib import Path
from typing import Any, Dict, List, Literal, NamedTuple, Optional, Tuple, get_args

# ── Who may use this server ─────────────────────────────────────────────────────
# Every route here moves the real mouse, presses real keys, drives the gamepad,
# reads the screen or writes files. Listening on 127.0.0.1 keeps the LAN out, but
# not the browser: any web page open while the agent runs can send requests to
# localhost. Such a page cannot read the replies, but it does not need to. A
# no-cors POST with a JSON body still reaches the route, and the click happens.
# So every request is checked before any route runs (the middleware added where
# the app is made, below):
#   - a Host other than localhost or 127.0.0.1 is refused with 400, against DNS
#     rebinding (a hostile name made to resolve to 127.0.0.1),
#   - an Origin header that is not the agent page's is refused with 403. Browsers
#     send Origin on every cross-site POST, no-cors included, and Vite's proxy
#     passes it on, so this also refuses a site that aims at localhost:5173/api,
#   - every route except GET /health needs this launch's token, or 401. That
#     covers what Origin cannot: a browser sends no Origin on a plain GET, such
#     as an <img> pointed at /capture/frame.
# The token is new at every start (or AGENT_TOKEN from the environment). It is
# written to .agent-token, and Vite's dev server puts it in the page each time
# the page loads (tools/vite-agent-token.mjs). Other sites cannot read that page,
# so they cannot learn the token.

HOST = "127.0.0.1"
PORT = 8765
TOKEN_HEADER = "X-Agent-Token"
TOKEN_FILE = Path(__file__).parent / ".agent-token"
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}")
# The page as Vite serves it (vite.config.js, port 5173). A page from a second
# Vite that found 5173 taken, on 5174, is refused here and told where to go.
PAGE_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")
# Vite's proxy (changeOrigin) sends Host localhost:8765; direct calls 127.0.0.1.
BACKEND_HOSTS = ["localhost", "127.0.0.1"]
# The only route that answers without the token, so "is the backend up?" can be
# asked by anyone. It says that and nothing else.
OPEN_ROUTES = frozenset({("GET", "/health")})

# This launch's token. None until the server starts, and None refuses every
# request that needs a token, so importing this module serves nothing by mistake.
AGENT_TOKEN: Optional[str] = None


def choose_token(environ) -> str:
    """AGENT_TOKEN from the environment if it is set, else 32 random bytes."""
    given = (environ.get("AGENT_TOKEN") or "").strip()
    if not given:
        return secrets.token_urlsafe(32)
    # The token travels in an HTTP header and inside the page's HTML, so it is
    # held to characters that are safe in both, and long enough not to guess.
    if not TOKEN_PATTERN.fullmatch(given):
        raise ValueError("AGENT_TOKEN must be 32 to 256 characters, "
                         "each a letter, a digit, '-' or '_'")
    return given


def write_token_file(token: str, path: Path) -> None:
    """Replace `path` with `token` in one step, so Vite never reads half a token
    or an empty file."""
    replace_file(path, token, encoding="ascii")


def replace_file(path: Path, text: str, encoding: str = "utf-8") -> None:
    """Replace `path` with `text` in one step: a reader sees the old file or the
    new one, never half of one. Callers writing the same file from two threads
    at once hold a lock of their own, since both would use one temporary name."""
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding=encoding)
    for attempt in range(40):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            # Windows refuses to replace a file another process has open: Vite
            # opens the token file on every page load, for a moment, and an
            # editor or antivirus can hold any file the same way.
            if attempt == 39:
                tmp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def token_matches(given: Optional[bytes], expected: Optional[str]) -> bool:
    if not given or not expected:
        return False
    return hmac.compare_digest(given, expected.encode("ascii"))


def refusal(method: str, path: str, headers: List[Tuple[bytes, bytes]]) -> Optional[Tuple[int, str]]:
    """Why a request may not run, as (HTTP status, message), or None if it may.

    `headers` are the raw ASGI pairs, names lower-case. A header sent twice is
    refused rather than guessed at."""
    origins = [v for k, v in headers if k == b"origin"]
    if origins:
        origin = origins[0].decode("latin-1")
        if len(origins) > 1 or origin not in PAGE_ORIGINS:
            return 403, (f"requests from {origin[:100]!r} are not accepted: "
                         f"only the agent page at {PAGE_ORIGINS[0]} may use this backend")
    if (method, path) in OPEN_ROUTES:
        return None
    tokens = [v for k, v in headers if k == TOKEN_HEADER.lower().encode("ascii")]
    if len(tokens) != 1 or not token_matches(tokens[0], AGENT_TOKEN):
        return 401, (f"missing or wrong {TOKEN_HEADER}: the backend makes a new token each "
                     f"time it starts, so reload the agent page at {PAGE_ORIGINS[0]}")
    return None


def claim_port(host: str, port: int) -> socket.socket:
    """Bind the server's port, or raise OSError if something already holds it.

    Bound here rather than by uvicorn, and before the token is written: a second
    copy of the backend started by mistake must fail before it replaces the
    running one's token, or the page would be locked out of the backend that
    is actually serving it. uvicorn allows the port to be shared on Windows
    (SO_REUSEADDR there lets a second process bind it too); this does not. It
    does not slow a restart either: a closed backend's connections waiting out
    TIME_WAIT do not stop this bind on Windows."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):  # Windows
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        else:  # elsewhere this only allows a quick restart, never a second listener
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
    except OSError:
        sock.close()
        raise
    return sock


class LaunchFailed(Exception):
    """Why the backend cannot start, in words for its window."""


def launch(environ, token_file: Path, host: str = HOST, port: int = PORT) -> Tuple[socket.socket, str]:
    """Claim the port, then choose this launch's token and write it for Vite.

    In that order, so a copy that cannot serve never touches the token file.
    Returns the bound socket and the token; raises LaunchFailed with nothing
    left bound."""
    try:
        listener = claim_port(host, port)
    except OSError as e:
        raise LaunchFailed(f"Could not start on port {port} ({e}). Is the backend already "
                           f"running in another window? Close that one first.") from e
    try:
        token = choose_token(environ)
        write_token_file(token, token_file)
    except (OSError, ValueError) as e:
        listener.close()
        raise LaunchFailed(f"Could not set up the page's token: {e}") from e
    return listener, token


if __name__ == "__main__":
    # Done first, before the slow imports below, so the token is on disk well
    # within the 4 s start.bat waits before it opens the page; a page opened
    # earlier than that would get the last launch's token and have to be
    # reloaded.
    try:
        _listener, AGENT_TOKEN = launch(os.environ, TOKEN_FILE)
    except LaunchFailed as e:
        print(e)
        sys.exit(1)

# Windows DPI-awareness — must be set BEFORE pyautogui imports
if platform.system() == "Windows":
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

import pyautogui
import pyperclip
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware
import uvicorn

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.0

SCREEN_W, SCREEN_H = pyautogui.size()

# ── Windows low-level key input (SendInput + scan codes) ───────────────────────
# pyautogui uses the legacy keybd_event API WITHOUT the extended-key flag, so
# arrow/nav keys are delivered as their numpad twins — browsers and games then
# ignore them (or read digits when NumLock is on). We instead use SendInput with
# hardware SCAN CODES, which is also the only input DirectInput games accept.
SENDINPUT_OK = False
if platform.system() == "Windows":
    try:
        import ctypes
        from ctypes import wintypes

        _ULONG_PTR = ctypes.POINTER(ctypes.c_ulong)

        class _KEYBDINPUT(ctypes.Structure):
            _fields_ = [("wVk", ctypes.c_ushort), ("wScan", ctypes.c_ushort),
                        ("dwFlags", ctypes.c_ulong), ("time", ctypes.c_ulong),
                        ("dwExtraInfo", _ULONG_PTR)]

        class _MOUSEINPUT(ctypes.Structure):
            _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long),
                        ("mouseData", ctypes.c_ulong), ("dwFlags", ctypes.c_ulong),
                        ("time", ctypes.c_ulong), ("dwExtraInfo", _ULONG_PTR)]

        class _INPUTUNION(ctypes.Union):
            _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT)]

        class _INPUT(ctypes.Structure):
            _fields_ = [("type", ctypes.c_ulong), ("u", _INPUTUNION)]

        _INPUT_KEYBOARD = 1
        _KEYEVENTF_EXTENDEDKEY = 0x0001
        _KEYEVENTF_KEYUP = 0x0002
        _KEYEVENTF_SCANCODE = 0x0008

        # Set-1 scan codes. 0xE0xx = extended key (real arrows, not numpad).
        _SCAN = {
            "escape": 0x01, "esc": 0x01,
            "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06,
            "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0A, "0": 0x0B,
            "-": 0x0C, "=": 0x0D, "backspace": 0x0E, "tab": 0x0F,
            "q": 0x10, "w": 0x11, "e": 0x12, "r": 0x13, "t": 0x14,
            "y": 0x15, "u": 0x16, "i": 0x17, "o": 0x18, "p": 0x19,
            "[": 0x1A, "]": 0x1B, "enter": 0x1C, "return": 0x1C,
            "ctrl": 0x1D, "ctrlleft": 0x1D,
            "a": 0x1E, "s": 0x1F, "d": 0x20, "f": 0x21, "g": 0x22,
            "h": 0x23, "j": 0x24, "k": 0x25, "l": 0x26, ";": 0x27, "'": 0x28,
            "`": 0x29, "shift": 0x2A, "shiftleft": 0x2A, "\\": 0x2B,
            "z": 0x2C, "x": 0x2D, "c": 0x2E, "v": 0x2F, "b": 0x30,
            "n": 0x31, "m": 0x32, ",": 0x33, ".": 0x34, "/": 0x35,
            "shiftright": 0x36, "alt": 0x38, "altleft": 0x38,
            "space": 0x39, "capslock": 0x3A,
            "f1": 0x3B, "f2": 0x3C, "f3": 0x3D, "f4": 0x3E, "f5": 0x3F,
            "f6": 0x40, "f7": 0x41, "f8": 0x42, "f9": 0x43, "f10": 0x44,
            "f11": 0x57, "f12": 0x58,
            # Extended (0xE0-prefixed) — the ones pyautogui gets wrong
            "up": 0xE048, "down": 0xE050, "left": 0xE04B, "right": 0xE04D,
            "home": 0xE047, "end": 0xE04F, "pageup": 0xE049, "pagedown": 0xE051,
            "insert": 0xE052, "delete": 0xE053, "del": 0xE053,
            "ctrlright": 0xE01D, "altright": 0xE038,
            "win": 0xE05B, "winleft": 0xE05B, "winright": 0xE05C,
        }

        def _send_scan(scan: int, keyup: bool = False) -> None:
            flags = _KEYEVENTF_SCANCODE
            if scan & 0xE000 == 0xE000:
                flags |= _KEYEVENTF_EXTENDEDKEY
            if keyup:
                flags |= _KEYEVENTF_KEYUP
            inp = _INPUT(type=_INPUT_KEYBOARD,
                         u=_INPUTUNION(ki=_KEYBDINPUT(0, scan & 0xFF, flags, 0, None)))
            ctypes.windll.user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(_INPUT))

        SENDINPUT_OK = True
    except Exception:
        SENDINPUT_OK = False


def _scan_for(key: str):
    """Scan code for a key name, or None if we don't have one."""
    if not SENDINPUT_OK:
        return None
    return _SCAN.get(key.strip().lower())

# ── Optional capability modules (graceful degradation) ──────────────────────────
# Each is best-effort: if the package/driver is missing the server still runs and
# the matching endpoints return {"ok": False, "available": False, ...}.
import base64
import io

try:
    from PIL import Image
except Exception:
    Image = None

# Gamepad emulation — Windows: `pip install vgamepad` + the free ViGEmBus driver.
try:
    import vgamepad as vg
    GAMEPAD_AVAILABLE = True
except Exception:
    vg = None
    GAMEPAD_AVAILABLE = False

# Native DirectX screen capture — Windows: `pip install dxcam`.
try:
    import dxcam
    CAPTURE_AVAILABLE = True
except Exception:
    dxcam = None
    CAPTURE_AVAILABLE = False

# Window enumeration — `pip install pygetwindow` (ships with pyautogui on Windows).
try:
    import pygetwindow as gw
    WINDOWS_API = True
except Exception:
    gw = None
    WINDOWS_API = False

# Game speed control / "pause-to-think" — Windows: `pip install xspeedhack`.
try:
    import xspeedhack as xsh
    SPEEDHACK_AVAILABLE = True
except Exception:
    xsh = None
    SPEEDHACK_AVAILABLE = False

# Process lookup (for attaching the speed hack to a running game).
try:
    import psutil
except Exception:
    psutil = None

MAX_CAP_W = 1280  # keep in sync with the frontend's MAX_FRAME_W

# Lazy singletons created on first use
_gamepad = None
_camera = None
_capture_region = None   # (left, top, right, bottom) in real screen px
_speed_client = None

class PageOnly:
    """Refuse, before any route runs, a request that did not come from the
    agent page (see "Who may use this server" at the top).

    Plain ASGI rather than a FastAPI dependency: a dependency runs after the
    body has been read and parsed, and after routing, so a refused request
    could still get a 422 or 404 that says something about the routes.

    A refusal is {"ok": false, "detail": "..."}, the shape FastAPI gives its
    own refusals, so the page reads it as "nothing ran" (the Ollama relay
    treats that as fatal rather than retrying it)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            refused = refusal(scope["method"], scope["path"], scope["headers"])
            if refused is not None:
                status, message = refused
                await JSONResponse({"ok": False, "detail": message}, status_code=status)(scope, receive, send)
                return
        elif scope["type"] == "websocket":
            # No route takes one, and none is let through unchecked. 1008 is
            # "policy violation".
            if refusal("GET", scope["path"], scope["headers"]) is not None:
                await send({"type": "websocket.close", "code": 1008})
                return
        await self.app(scope, receive, send)


class BodyReadBeforeRefusal:
    """Read what is left of a request's body before a refusal is sent.

    PageOnly and TrustedHostMiddleware answer without reading the body. uvicorn
    then closes the connection with the body still unread, Windows resets it,
    and the client can see "connection reset" instead of the refusal: through
    Vite's proxy, an empty HTTP 500 in place of the 401 that tells the operator
    to reload the page. Only error replies wait for the body, and only for so
    much of it; a route has always read its body before it answers."""

    MAX_BYTES = 16 * 1024 * 1024

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        body_read = False

        async def tracked_receive():
            nonlocal body_read
            message = await receive()
            if message["type"] != "http.request" or not message.get("more_body", False):
                body_read = True
            return message

        async def send_once_read(message):
            if message["type"] == "http.response.start" and message["status"] >= 400:
                seen = 0
                while not body_read and seen <= self.MAX_BYTES:
                    seen += len((await tracked_receive()).get("body", b""))
            await send(message)

        await self.app(scope, tracked_receive, send_once_read)


app = FastAPI(title="Game Agent Backend")
# No CORS middleware: the page reaches the backend through Vite's proxy, from its
# own origin, so no other origin ever needs to read a reply. CORS allowed every
# origin here before, which let any page read the screen through /capture/frame.
app.add_middleware(PageOnly)
# Added after PageOnly, so it runs before it: a request with a hostile Host is
# turned away before anything else looks at it.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=BACKEND_HOSTS)
# Added last, so it wraps both refusals above.
app.add_middleware(BodyReadBeforeRefusal)


def _capabilities():
    return {
        "gamepad": GAMEPAD_AVAILABLE,
        "capture": CAPTURE_AVAILABLE,
        "windows_api": WINDOWS_API,
        "speedhack": SPEEDHACK_AVAILABLE,
        # Where the Ollama relay sends requests, fixed at startup (see "Ollama
        # relay" below), so the page can show it instead of guessing.
        "ollama": _ollama_status(),
    }


@app.get("/health")
def health():
    # Answers without the token, so it says only that the backend is up. The
    # screen size and capabilities it used to include are behind the token, at
    # /screen/info and /capabilities.
    return {"status": "ok"}


@app.get("/capabilities")
def capabilities():
    return _capabilities()


# ── Mouse ──────────────────────────────────────────────────────────────────────

class MoveBody(BaseModel):
    x: int
    y: int
    duration: float = 0.15


class ClickBody(BaseModel):
    x: int
    y: int
    button: str = "left"
    clicks: int = 1
    move_duration: float = 0.15


class DragBody(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int
    duration: float = 0.3
    button: str = "left"


class ScrollBody(BaseModel):
    x: int
    y: int
    amount: int


def _on_screen(x: int, y: int) -> tuple:
    """Keep the pointer inside the screen, and out of its corners.

    pyautogui clamps an out-of-range move to the edge and then treats a pointer
    sitting in a corner as the user's abort signal — so one bad coordinate does
    not just miss, it makes every later click raise "fail-safe triggered" until
    something moves the mouse back. An off-screen request is a bug worth
    reporting rather than quietly rounding to the nearest pixel, so say so.
    """
    if not (0 <= x < SCREEN_W and 0 <= y < SCREEN_H):
        raise ValueError(
            f"({x},{y}) is outside the {SCREEN_W}x{SCREEN_H} screen")
    return max(1, min(SCREEN_W - 2, x)), max(1, min(SCREEN_H - 2, y))


@app.post("/mouse/move")
def mouse_move(b: MoveBody):
    try:
        x, y = _on_screen(b.x, b.y)
        pyautogui.moveTo(x, y, duration=b.duration)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/click")
def mouse_click(b: ClickBody):
    try:
        x, y = _on_screen(b.x, b.y)
        pyautogui.moveTo(x, y, duration=b.move_duration)
        pyautogui.click(button=b.button, clicks=b.clicks, interval=0.05)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/drag")
def mouse_drag(b: DragBody):
    try:
        # Both ends are checked before the pointer moves at all: a drag whose end
        # is off-screen would otherwise start, press the button and finish in a
        # corner, which is pyautogui's abort signal (see _on_screen).
        x1, y1 = _on_screen(b.x1, b.y1)
        x2, y2 = _on_screen(b.x2, b.y2)
        pyautogui.moveTo(x1, y1, duration=0.1)
        pyautogui.dragTo(x2, y2, duration=b.duration, button=b.button)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/scroll")
def mouse_scroll(b: ScrollBody):
    try:
        x, y = _on_screen(b.x, b.y)
        pyautogui.moveTo(x, y, duration=0.05)
        pyautogui.scroll(b.amount)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── How long one request may hold, and how much it may type ────────────────────
# A key hold used to sleep for whatever duration it was sent: hold_key with 600
# held a key down for ten minutes, on a worker thread nothing could interrupt
# (■ Stop only stops the page asking for more), and typed text had no limit at
# all. Held keys drive most real-time games, so rather than take hold_key away
# from games the agent has never seen, every hold is bounded here:
#   - a key is held at most KEY_HOLD_MAX_S per call, and a gamepad button, stick
#     or trigger at most GAMEPAD_HOLD_MAX_S (the limit those routes always had),
#   - a hold waits in steps of HOLD_STEP_S and asks _input_halted() before each,
#     so input that has been told to stop is let go within a step (and a hold
#     asked for while it is halted presses nothing),
#   - whatever goes down comes back up, even when a step raises, and a pyautogui
#     key-up goes through even while the mouse is in a screen corner,
#   - at most TYPE_TEXT_MAX_CHARS characters are typed per call, TYPE_INTERVAL_MAX_S
#     apart at most, so a call to type text ends within a minute.
# A value outside its bounds is brought inside them, not refused, and the reply's
# "limit" says what was asked and what was done, so the page can tell the model it
# was cut. The page's tool schemas state the same numbers (src/agent/inputLimits.js;
# tools/check-agent.mjs fails if they differ).
KEY_HOLD_MAX_S = 5.0
GAMEPAD_HOLD_MAX_S = 5.0
# A button pressed and let go in the same instant is missed by games that read
# the pad once a frame, so a press lasts at least this long.
GAMEPAD_BUTTON_MIN_S = 0.02
HOLD_STEP_S = 0.1
TYPE_TEXT_MAX_CHARS = 300
TYPE_INTERVAL_MAX_S = 0.2


def _input_halted() -> bool:
    """Whether injected input has been told to stop. Nothing tells it to yet, so
    this is always False; a kill switch will make it True, and every hold checks
    it before it presses anything and before each step."""
    return False


def _wait(seconds: float) -> None:
    """The one sleep a hold waits with (tools/check_backend.py stands in for it,
    so a check of a five-second hold takes no time)."""
    time.sleep(seconds)


def _clock() -> float:
    """The clock a hold keeps time by (tools/check_backend.py stands in a fake one
    that its _wait moves on)."""
    return time.monotonic()


def _within(value: float, low: float, high: float) -> float:
    """`value` brought inside low..high. JSON has no NaN or Infinity, but Python's
    parser reads both, so they can arrive. Infinity is brought inside like any
    other number. A NaN compares false with everything, so it would pass min()
    and max() unchanged and fail the sleep with a key already down; it counts as
    `low`."""
    if math.isnan(value):
        return low
    return max(low, min(high, value))


def _limit(requested, applied, low, high, unit: str) -> dict:
    """What a reply says about a bounded value: what was asked, what was done,
    the bounds, and whether the two differ.

    A value is not refused for being out of bounds, NaN and Infinity included:
    FastAPI's refusal repeats the value it refused, and a reply cannot hold NaN
    or Infinity, so it would fail as an HTTP 500. For the same reason they are
    reported here as text ("nan", "inf")."""
    return {"requested": requested if math.isfinite(requested) else str(requested),
            "applied": applied, "min": low, "max": high, "unit": unit,
            "clamped": applied != requested}


def _hold(seconds: float) -> Tuple[float, bool]:
    """Wait `seconds` in steps of at most HOLD_STEP_S, asking _input_halted()
    before each one. Returns the seconds held and whether a halt cut it short.

    It waits for a deadline on the clock rather than counting steps: every sleep
    overshoots a little (up to a timer tick, about 15 ms, on Windows before Python
    3.11), and fifty steps' overshoot added up would stretch a 5 s hold by most of
    a second. A hold that reaches its deadline reports `seconds`; one that is
    halted reports the time it had held, to the millisecond."""
    start = _clock()
    while True:
        now = _clock()
        left = start + seconds - now
        if left <= 1e-9:
            return seconds, False
        if _input_halted():
            return round(now - start, 3), True
        _wait(min(HOLD_STEP_S, left))


def _pyautogui_key_up(key: str) -> None:
    """pyautogui's key-up, for letting go of a key a hold pressed. pyautogui
    refuses every call while the mouse is in a screen corner (its fail-safe, the
    emergency stop in SETUP.md), a key-up included, which would leave the key down
    for good at the moment the operator wants input to stop. A key-up refused that
    way goes straight to pyautogui's platform layer, which does not check; new
    presses are still refused."""
    try:
        pyautogui.keyUp(key)
    except pyautogui.FailSafeException:
        pyautogui.platformModule._keyUp(key)


def _hold_down(press, release, keys: list, seconds: float) -> Tuple[float, bool]:
    """Press `keys` in order, hold them for `seconds` (see _hold), and release them
    in reverse order. Every key it tried to press is released, whatever happens in
    between: a press or a step that raises, or a halt. That includes a press that
    raised part-way, which may have gone down (a gamepad button set but its report
    not sent); letting go of a key that is up does no harm, and a key left down
    would stay down. A release that raises does not stop the others; the first
    such error is raised once all were tried.

    While input is halted it presses nothing, and returns (0.0, True)."""
    if _input_halted():
        return 0.0, True
    pressed = []
    try:
        for k in keys:
            pressed.append(k)
            press(k)
        return _hold(seconds)
    finally:
        failed = None
        for k in reversed(pressed):
            try:
                release(k)
            except Exception as e:
                failed = failed or e
        if failed is not None:
            raise failed


# ── Keyboard ───────────────────────────────────────────────────────────────────

class KeyBody(BaseModel):
    key: str


class HoldBody(BaseModel):
    key: str
    duration: float


class TypeBody(BaseModel):
    text: str
    interval: float = 0.03


def _parse_key(key: str):
    return [k.strip().lower() for k in key.split("+") if k.strip()]


def _active_window_title() -> str:
    """Best-effort title of the window that currently has keyboard focus.
    Used for diagnostics: synthetic keys go to whatever is focused."""
    try:
        if platform.system() == "Windows":
            import ctypes
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            n = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(n + 1)
            ctypes.windll.user32.GetWindowTextW(hwnd, buf, n + 1)
            return buf.value or ""
    except Exception:
        pass
    return ""


class KeyPressBody(BaseModel):
    key: str
    # Hold the key down briefly. A 0ms down/up is often missed by browsers and
    # games, which sample input per frame — hold long enough to be seen.
    hold: float = 0.08


@app.post("/keyboard/press")
def key_press(b: KeyPressBody):
    try:
        keys = _parse_key(b.key)
        focus = _active_window_title()
        hold = max(0.0, min(b.hold, 2.0))

        # Preferred path: SendInput with hardware scan codes (correct extended-key
        # handling; works with browsers AND DirectInput games).
        scans = [_scan_for(k) for k in keys]
        if scans and all(s is not None for s in scans):
            *mods, last = scans
            for m in mods:
                _send_scan(m)
            _send_scan(last)
            time.sleep(hold)
            _send_scan(last, keyup=True)
            for m in reversed(mods):
                _send_scan(m, keyup=True)
            return {"ok": True, "focus": focus, "held": hold, "method": "sendinput"}

        # Fallback: pyautogui (non-Windows, or a key we have no scan code for)
        if len(keys) > 1:
            *mods, last = keys
            for m in mods:
                pyautogui.keyDown(m)
            pyautogui.keyDown(last)
            time.sleep(hold)
            pyautogui.keyUp(last)
            for m in reversed(mods):
                pyautogui.keyUp(m)
        else:
            pyautogui.keyDown(keys[0])
            time.sleep(hold)
            pyautogui.keyUp(keys[0])
        return {"ok": True, "focus": focus, "held": hold, "method": "pyautogui"}
    except Exception as e:
        return {"ok": False, "error": str(e), "focus": _active_window_title()}


@app.post("/keyboard/hold")
def key_hold(b: HoldBody):
    duration = _within(b.duration, 0.0, KEY_HOLD_MAX_S)
    limit = _limit(b.duration, duration, 0.0, KEY_HOLD_MAX_S, "s")
    keys = _parse_key(b.key)
    if not keys:
        return {"ok": False, "error": f"no key to hold in {b.key!r}", "limit": limit}
    try:
        scans = [_scan_for(k) for k in keys]
        if all(s is not None for s in scans):
            method = "sendinput"
            held, halted = _hold_down(_send_scan, lambda s: _send_scan(s, keyup=True), scans, duration)
        else:
            method = "pyautogui"
            held, halted = _hold_down(pyautogui.keyDown, _pyautogui_key_up, keys, duration)
        return {"ok": True, "method": method, "held": held, "halted": halted, "limit": limit}
    except Exception as e:
        return {"ok": False, "error": str(e), "limit": limit}


@app.post("/keyboard/type")
def key_type(b: TypeBody):
    text = b.text[:TYPE_TEXT_MAX_CHARS]
    limit = _limit(len(b.text), len(text), 0, TYPE_TEXT_MAX_CHARS, "characters")
    interval = _within(b.interval, 0.0, TYPE_INTERVAL_MAX_S)
    try:
        if all(ord(c) < 128 for c in text):
            pyautogui.typewrite(text, interval=interval)
        else:
            prev = ""
            try:
                prev = pyperclip.paste()
            except Exception:
                pass
            pyperclip.copy(text)
            pyautogui.hotkey("ctrl", "v")
            time.sleep(0.1)
            if prev:
                try:
                    pyperclip.copy(prev)
                except Exception:
                    pass
        return {"ok": True, "limit": limit}
    except Exception as e:
        return {"ok": False, "error": str(e), "limit": limit}


# ── Screen info ────────────────────────────────────────────────────────────────

@app.get("/screen/info")
def screen_info():
    return {"width": SCREEN_W, "height": SCREEN_H, "platform": platform.system()}


# ── Session log files ──────────────────────────────────────────────────────────
# The in-page log is capped and lives only in browser memory, so a long run loses
# its early history and a crashed tab loses everything. Every line is mirrored to
# a file here so the full run is always available for troubleshooting.

LOG_DIR = Path(__file__).parent / "logs"

# What one request may add to a session log or a snapshot. Far above what the
# page sends (it flushes every 2 s, in batches it splits to fit: logBatches in
# src/agent/backend.js holds the same two log limits, and tools/check-agent.mjs
# fails if they differ), so these only stop a runaway or a hostile request from
# filling the disk in one go.
LOG_APPEND_MAX_LINES = 1000
LOG_APPEND_MAX_BYTES = 1024 * 1024
SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024


def _too_large(what: str, limit: str) -> JSONResponse:
    return JSONResponse({"ok": False, "error": f"{what} is over the limit of {limit}; nothing was written"},
                        status_code=413)


class LogLines(BaseModel):
    session: str
    lines: List[str]


def _log_path(session: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", session)[:80] or "session"
    return LOG_DIR / f"agent-{safe}.log"


@app.post("/log/append")
def log_append(b: LogLines):
    """Append log lines to this session's file, creating it on first write."""
    if len(b.lines) > LOG_APPEND_MAX_LINES:
        return _too_large(f"{len(b.lines)} lines", f"{LOG_APPEND_MAX_LINES} lines")
    # Counted as written: one newline each, and "replace" for half an emoji (a
    # line the page cut short mid-character), which would otherwise fail the
    # whole batch here and in the write below.
    size = sum(len(line.rstrip("\n").encode("utf-8", "replace")) + 1 for line in b.lines)
    if size > LOG_APPEND_MAX_BYTES:
        return _too_large(f"{size} bytes of log", f"{LOG_APPEND_MAX_BYTES} bytes")
    try:
        LOG_DIR.mkdir(exist_ok=True)
        path = _log_path(b.session)
        with path.open("a", encoding="utf-8", errors="replace") as fh:
            for line in b.lines:
                fh.write(line.rstrip("\n") + "\n")
        return {"ok": True, "path": str(path), "bytes": path.stat().st_size}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Snapshots: what the agent was actually looking at ─────────────────────────
# Troubleshooting a run from its log alone has meant guessing at what the screen
# looked like, and the guesses have been wrong more than once. A board misread as
# untouched and a board that IS untouched write the same line. So when a read
# fails or a game ends, the frame and the board as it was read are written side
# by side under logs/snapshots/, and the pair settles it.


class Snapshot(BaseModel):
    session: str
    tag: str
    png: Optional[str] = None     # base64, without the data: prefix
    text: Optional[str] = None


@app.post("/log/snapshot")
def log_snapshot(b: Snapshot):
    # Measured before decoding, so an oversized image is never decoded or written.
    # Four base64 characters carry at most three bytes. The page measures the
    # same way before it sends (snapshotBytes in src/agent/backend.js), and
    # scales a frame down to fit rather than lose it.
    size = len(b.png or "") * 3 // 4 + len((b.text or "").encode("utf-8", "replace"))
    if size > SNAPSHOT_MAX_BYTES:
        return _too_large(f"a snapshot of about {size} bytes", f"{SNAPSHOT_MAX_BYTES} bytes")
    try:
        stamp = datetime.datetime.now().strftime("%H%M%S")
        safe_session = re.sub(r"[^A-Za-z0-9_-]+", "-", b.session)[:60] or "session"
        safe_tag = re.sub(r"[^A-Za-z0-9_-]+", "-", b.tag)[:40] or "snap"
        folder = LOG_DIR / "snapshots" / safe_session
        folder.mkdir(parents=True, exist_ok=True)
        written = []
        if b.png:
            path = folder / f"{stamp}-{safe_tag}.png"
            path.write_bytes(base64.b64decode(b.png))
            written.append(str(path))
        if b.text:
            path = folder / f"{stamp}-{safe_tag}.txt"
            path.write_text(b.text, encoding="utf-8", errors="replace")
            written.append(str(path))
        return {"ok": True, "files": written}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/log/list")
def log_list():
    """Most recent session logs first, so the last run is easy to find."""
    if not LOG_DIR.exists():
        return {"dir": str(LOG_DIR), "files": []}
    files = sorted(LOG_DIR.glob("agent-*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
    return {
        "dir": str(LOG_DIR),
        "files": [
            {"name": p.name, "path": str(p), "bytes": p.stat().st_size,
             "modified": datetime.datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")}
            for p in files[:25]
        ],
    }


# ── Memory storage ─────────────────────────────────────────────────────────────

MEMORY_FILE = Path(__file__).parent / "game-agent-memory.json"

# How a game ended: the same names, in the same order, as OUTCOMES in
# src/agent/outcomes.js, and tools/check-agent.mjs fails if they drift apart.
# They were two sets once. The page recorded a solver's win as "win" while this
# file counted "won", so wins were split across two keys and outcomes.won stayed
# at 0. An outcome outside this list is now refused (HTTP 422) instead of quietly
# becoming a new key.
Outcome = Literal["won", "lost", "stuck", "ended", "aborted"]

# Names from before the vocabulary was shared. A page loaded before the update
# (a browser tab left open on the test PC) still sends "win", and memory files
# written before it still hold it.
LEGACY_OUTCOMES = {"win": "won"}


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _fold_legacy_outcomes(data: Dict[str, Any]) -> Dict[str, Any]:
    """Rename legacy outcome names in a whole memory file, in place.

    Each legacy count is added to its new name and the old key removed, so a
    second pass finds nothing left to move: running this on every load and every
    save cannot count a win twice. Returns `data` for convenience."""
    if not isinstance(data, dict):
        return data
    for entry in data.values():
        if not isinstance(entry, dict):
            continue
        outcomes = entry.get("outcomes")
        if isinstance(outcomes, dict):
            for old, new in LEGACY_OUTCOMES.items():
                if old in outcomes:
                    outcomes[new] = _count(outcomes.get(new)) + _count(outcomes.pop(old))
        history = entry.get("scoreHistory")
        for item in history if isinstance(history, list) else []:
            if isinstance(item, dict) and item.get("outcome") in LEGACY_OUTCOMES:
                item["outcome"] = LEGACY_OUTCOMES[item["outcome"]]
    return data


def _load_all() -> Dict[str, Any]:
    if MEMORY_FILE.exists():
        try:
            data = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return _fold_legacy_outcomes(data)
    return {}


def _save_all(data: Dict[str, Any]) -> None:
    _fold_legacy_outcomes(data)
    MEMORY_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:64]


class MemoryPatch(BaseModel):
    gameDesc: str
    # What the agent has learned about this game, as opposed to what happened in
    # one session: weights proven better by self-play, and where the game's
    # furniture sits on screen. Both are replaced wholesale rather than appended,
    # because only the current best is worth keeping.
    tuning: Optional[Dict[str, Any]] = None
    layout: Optional[Dict[str, Any]] = None
    outcome: Optional[Outcome] = None
    score: Optional[float] = None
    strategy: Optional[str] = None
    strategyReason: Optional[str] = None
    discoveries: Optional[List[str]] = None
    avoidPatterns: Optional[List[str]] = None
    durationSeconds: Optional[int] = None
    turnCount: Optional[int] = None

    @field_validator("outcome", mode="before")
    @classmethod
    def _legacy_outcome(cls, value: Any) -> Any:
        # Runs before the Literal check, so "win" arrives as "won" and anything
        # else unknown still fails it.
        return LEGACY_OUTCOMES.get(value, value) if isinstance(value, str) else value


@app.get("/memory/{game_key}")
def memory_get(game_key: str):
    data = _load_all()
    return data.get(game_key, {})


@app.post("/memory/{game_key}")
def memory_patch(game_key: str, patch: MemoryPatch):
    data = _load_all()
    entry = data.get(game_key, {
        "gameKey": game_key,
        "gameDesc": patch.gameDesc,
        "sessions": 0,
        "bestScore": None,
        "scoreHistory": [],
        "totalTurns": 0,
        "totalSeconds": 0,
        "outcomes": {name: 0 for name in get_args(Outcome)},
        "strategies": [],
        "strategyReasons": [],
        "discoveries": [],
        "avoidPatterns": [],
        "lastPlayed": None,
    })

    entry["sessions"] = entry.get("sessions", 0) + 1

    if patch.outcome:
        outcomes = entry.setdefault("outcomes", {})
        outcomes[patch.outcome] = outcomes.get(patch.outcome, 0) + 1

    if patch.score is not None:
        current_best = entry.get("bestScore")
        if current_best is None or patch.score > current_best:
            entry["bestScore"] = patch.score
        history = entry.setdefault("scoreHistory", [])
        history.append({
            "score": patch.score,
            "outcome": patch.outcome,
            "session": entry["sessions"],
        })
        entry["scoreHistory"] = history[-20:]

    if patch.tuning:
        entry["tuning"] = patch.tuning
    if patch.layout:
        entry["layout"] = patch.layout

    if patch.turnCount:
        entry["totalTurns"] = entry.get("totalTurns", 0) + patch.turnCount
    if patch.durationSeconds:
        entry["totalSeconds"] = entry.get("totalSeconds", 0) + patch.durationSeconds

    if patch.strategy and patch.strategy.strip():
        strategies = entry.setdefault("strategies", [])
        if patch.strategy not in strategies:
            strategies.insert(0, patch.strategy)
        entry["strategies"] = strategies[:10]
        if patch.strategyReason and patch.strategyReason.strip():
            reasons = entry.setdefault("strategyReasons", [])
            reasons.insert(0, f"{patch.strategy}: {patch.strategyReason}")
            entry["strategyReasons"] = reasons[:10]

    if patch.discoveries:
        disc = entry.setdefault("discoveries", [])
        for d in patch.discoveries:
            if d and d not in disc:
                disc.append(d)
        entry["discoveries"] = disc[-20:]

    if patch.avoidPatterns:
        avoid = entry.setdefault("avoidPatterns", [])
        for a in patch.avoidPatterns:
            if a and a not in avoid:
                avoid.append(a)
        entry["avoidPatterns"] = avoid[-10:]

    entry["lastPlayed"] = datetime.datetime.utcnow().isoformat() + "Z"

    data[game_key] = entry
    _save_all(data)
    return {"ok": True, "entry": entry}


# ── Ollama relay ───────────────────────────────────────────────────────────────
# The browser holds a long idle connection while the model thinks, and security
# software / network gear on the path frequently kills such sockets mid-request
# (observed: sockets dropped at a fixed ~19s while Ollama was still computing).
# Relaying through this local backend keeps the browser's connection on
# localhost and lets Python own the long-running call, with its own timeout.
#
# The relay sends requests to ONE Ollama server, chosen when the backend starts,
# never to an address a request names. It used to take base_url from each
# request and return whatever that address answered, error text included, which
# made it a proxy into the LAN for anything that could reach this backend. The
# server is, in order:
#   1. OLLAMA_BASE_URL in the backend's environment,
#   2. "ollamaBase" in agent-config.json next to this file (git ignores it; the
#      page's OLLAMA SERVER field saves it through POST /config/ollama-base),
#   3. http://localhost:11434, Ollama on this PC.
# The first of those that is set decides. If its value is not a usable address
# the relay refuses every request and says why, rather than quietly sending the
# model's requests to another server. A saved change is used from the next start.

import threading
import urllib.error
import urllib.parse
import urllib.request

OLLAMA_DEFAULT_BASE = "http://localhost:11434"
OLLAMA_BASE_ENV = "OLLAMA_BASE_URL"
CONFIG_FILE = Path(__file__).parent / "agent-config.json"
CONFIG_OLLAMA_KEY = "ollamaBase"
# How long to wait for Ollama's model list, and how much of it to read. A list
# answers in well under a second; this only stops a host that never does.
OLLAMA_TAGS_TIMEOUT_S = 15
OLLAMA_TAGS_MAX_BYTES = 4 * 1024 * 1024

_HOST_NAME = re.compile(r"[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?")


class OllamaServer(NamedTuple):
    base: Optional[str]    # e.g. "http://192.168.1.50:11434"; None when unusable
    source: str            # OLLAMA_BASE_URL, agent-config.json or default
    error: Optional[str]   # why `base` is None, in words for the operator


def _shown(text: str) -> str:
    """`text` quoted for a refusal, with everything before its last @ (after
    any http://) hidden. A refusal is printed in the backend window, returned to
    the page and kept in its logs, so a password in a refused address must not
    appear in it, however the address around it is written."""
    if "@" in text:
        head, _, tail = text.rpartition("@")
        scheme = re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", head)
        text = f"{scheme.group(0) if scheme else ''}***@{tail}"
    return repr(text[:100])


def ollama_base_from(value: Any) -> str:
    """`value` as an Ollama server address the relay may use, tidied, or
    ValueError saying why it may not be used.

    Only http or https with a host name or IP address, optionally a port and a
    path prefix (for a server behind a reverse proxy), in plain ASCII. Nothing
    else: a file: or ftp: address, a user name and password, or a query would
    each make the relay something other than a client of one Ollama server, and
    a character urllib cannot put in a request line would pass here only to fail
    every request later, looking like a server that does not answer."""
    example = "for example http://192.168.1.50:11434"
    if not isinstance(value, str):
        raise ValueError(f"the address must be text, {example}")
    text = value.strip()
    if not text:
        raise ValueError(f"the address is empty; give one, {example}")
    if len(text) > 300:
        raise ValueError("the address is over 300 characters long")
    # Before anything that quotes the address in full.
    if "@" in text:
        raise ValueError(f"{_shown(text)} has a user name or password (an @) in it, which the relay does not send")
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in text):
        raise ValueError(f"{_shown(text)} has a space or a control character in it")
    if not text.isascii():
        raise ValueError(f"{_shown(text)} has a character that is not plain ASCII; "
                         f"write an international host name in its xn-- form")
    try:
        parts = urllib.parse.urlsplit(text)
        _ = parts.port  # read for its check: an out-of-range or non-numeric port raises
    except ValueError as e:
        raise ValueError(f"{_shown(text)} is not a web address ({e})") from None
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError(f"{_shown(text)} does not start with http:// or https://; {example}")
    host = parts.hostname or ""
    if host.startswith("[") or ":" in host:
        try:
            ipaddress.IPv6Address(host.strip("[]"))
        except ValueError:
            raise ValueError(f"{_shown(text)} does not name a host; {example}") from None
    elif not _HOST_NAME.fullmatch(host):
        raise ValueError(f"{_shown(text)} does not name a host; {example}")
    if parts.port == 0 or parts.netloc.endswith(":"):
        raise ValueError(f"{_shown(text)} has an empty port or port 0; {example}")
    if parts.query or parts.fragment or "?" in text or "#" in text:
        raise ValueError(f"{_shown(text)} has a ? or # part, which a server address does not")
    path = parts.path.rstrip("/")
    # The relay adds /v1/chat/completions and /api/tags itself.
    if re.search(r"/(?:v1|api)(?:/|$)", path):
        raise ValueError(f"{_shown(text)} includes an Ollama API path; give only the server, {example}")
    return f"{parts.scheme.lower()}://{parts.netloc}{path}"


class ConfigUnreadable(Exception):
    """agent-config.json exists but cannot be used, in words for the operator."""


def read_config(path: Path) -> Dict[str, Any]:
    """The settings in agent-config.json, or {} when there is no such file.

    Whatever is wrong with the file, the error is ConfigUnreadable and nothing
    else: the backend reads it while starting, and a file edited by hand must
    cost the Ollama relay its server, never the mouse, keyboard and capture."""
    try:
        raw = path.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError as e:
        raise ConfigUnreadable(f"{path.name} cannot be read ({e})") from None
    try:
        # UTF-16 with its byte-order mark is what Windows PowerShell 5.1 writes
        # for `echo ... > agent-config.json`; utf-8-sig also reads the mark
        # Notepad can put before UTF-8.
        if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
            text = raw.decode("utf-16")
        else:
            text = raw.decode("utf-8-sig")
    except UnicodeDecodeError as e:
        raise ConfigUnreadable(f"{path.name} is not UTF-8 text ({e}); save it as UTF-8 or delete it") from None
    try:
        data = json.loads(text)
    except (ValueError, RecursionError) as e:
        raise ConfigUnreadable(f"{path.name} is not valid JSON ({e}); fix it or delete it") from None
    if not isinstance(data, dict):
        raise ConfigUnreadable(f"{path.name} does not hold a JSON object ({{...}}); fix it or delete it")
    return data


def choose_ollama_base(environ, config_file: Path) -> OllamaServer:
    """The Ollama server the relay uses for this run (see the top of this section)."""
    given = (environ.get(OLLAMA_BASE_ENV) or "").strip()
    if given:
        try:
            return OllamaServer(ollama_base_from(given), OLLAMA_BASE_ENV, None)
        except ValueError as e:
            return OllamaServer(None, OLLAMA_BASE_ENV, f"{OLLAMA_BASE_ENV} is not a usable Ollama address: {e}")
    try:
        saved = read_config(config_file).get(CONFIG_OLLAMA_KEY)
    except ConfigUnreadable as e:
        return OllamaServer(None, config_file.name, str(e))
    if saved is None or (isinstance(saved, str) and not saved.strip()):
        return OllamaServer(OLLAMA_DEFAULT_BASE, "default", None)
    try:
        return OllamaServer(ollama_base_from(saved), config_file.name, None)
    except ValueError as e:
        return OllamaServer(None, config_file.name,
                            f"{CONFIG_OLLAMA_KEY} in {config_file.name} is not a usable Ollama address: {e}")


def _startup_ollama_server() -> OllamaServer:
    # choose_ollama_base turns every problem it knows of into an error for the
    # relay. Anything it does not know of must still not stop the backend from
    # starting: this runs on import, before any route exists.
    try:
        return choose_ollama_base(os.environ, CONFIG_FILE)
    except Exception as e:
        return OllamaServer(None, CONFIG_FILE.name,
                            f"the Ollama server could not be chosen ({type(e).__name__}: {e})")


# Chosen once, when the backend starts. Nothing a request sends changes it.
OLLAMA_SERVER = _startup_ollama_server()
_config_lock = threading.Lock()


def _saved_ollama_base() -> Optional[str]:
    """What agent-config.json holds now, which is what the next start will use
    unless OLLAMA_BASE_URL is set. None when it holds nothing usable."""
    try:
        return ollama_base_from(read_config(CONFIG_FILE).get(CONFIG_OLLAMA_KEY))
    except (ConfigUnreadable, ValueError):
        return None


def _ollama_status() -> Dict[str, Any]:
    server = OLLAMA_SERVER
    return {"base": server.base, "source": server.source, "error": server.error,
            "saved": _saved_ollama_base()}


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse to follow a redirect: it would send the request (the whole prompt,
    screenshot included) to a server other than the one configured. The reply
    then arrives as an HTTPError with the 3xx status."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_ollama_opener = urllib.request.build_opener(_NoRedirects)


def _ollama_open(req: urllib.request.Request, timeout: float):
    """Every request to Ollama goes through here (tools/check_backend.py stands
    in for it, so the checks never reach a real server)."""
    return _ollama_opener.open(req, timeout=timeout)


def _ollama_unusable(server: OllamaServer) -> JSONResponse:
    # {"detail": ...} like the backend's other refusals, so the page gives the
    # session up at once with this message instead of waiting on a model that
    # no request can reach.
    return JSONResponse({"ok": False, "detail": f"{server.error}. Fix it, then restart the backend (start.bat)."},
                        status_code=503)


def _redirected(server: OllamaServer, e: urllib.error.HTTPError) -> str:
    where = e.headers.get("Location") if e.headers is not None else None
    return (f"the Ollama server at {server.base} answered with a redirect (HTTP {e.code}"
            f"{f' to {where[:200]}' if where else ''}), which the relay does not follow. "
            f"Set the Ollama server to the address Ollama itself answers on.")


def _http_error_text(e: urllib.error.HTTPError) -> str:
    try:
        return e.read().decode("utf-8", errors="replace")[:500] or str(e)
    except Exception:
        return str(e)


def _no_answer(e: Exception, started: float) -> Dict[str, Any]:
    # timedOut tells the page this was the relay's timeout running out, not a
    # connection that dropped. It treats the one as a deadline and the other as
    # worth asking again at once (src/agent/llmErrors.js). urllib raises the
    # timeout bare while reading the reply, and inside a URLError while
    # connecting.
    timed_out = isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError)
    return {"ok": False, "status": 0, "elapsed": round(time.time() - started, 1),
            "timedOut": timed_out, "error": f"{type(e).__name__}: {e}"}


class OllamaRelayBody(BaseModel):
    # No base_url: the relay sends to OLLAMA_SERVER only. A page from before this
    # change still sends one, and it is ignored (pydantic drops unknown fields).
    payload: Dict[str, Any]
    timeout: float = 600.0


@app.post("/llm/ollama")
def llm_ollama(b: OllamaRelayBody):
    server = OLLAMA_SERVER
    if server.base is None:
        return _ollama_unusable(server)
    data = json.dumps(b.payload).encode("utf-8")
    req = urllib.request.Request(
        server.base + "/v1/chat/completions", data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with _ollama_open(req, timeout=max(30.0, min(b.timeout, 1800.0))) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        return {"ok": True, "status": 200, "elapsed": round(time.time() - started, 1),
                "body": json.loads(body)}
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            # Asking again gets the same redirect, so this is a refusal the page
            # gives the session up on, not an answer from Ollama.
            return JSONResponse({"ok": False, "detail": _redirected(server, e)}, status_code=502)
        return {"ok": False, "status": e.code, "elapsed": round(time.time() - started, 1),
                "error": _http_error_text(e)}
    except Exception as e:
        return _no_answer(e, started)


def _model_entry(model: Dict[str, Any]) -> Dict[str, Any]:
    def text(value):
        return value if isinstance(value, str) else None

    details = model.get("details") if isinstance(model.get("details"), dict) else {}
    families = details.get("families")
    return {
        "name": model["name"],
        "size": model.get("size") if isinstance(model.get("size"), int) else None,
        "modifiedAt": text(model.get("modified_at")),
        "family": text(details.get("family")),
        "families": [f for f in families if isinstance(f, str)] if isinstance(families, list) else [],
        "parameterSize": text(details.get("parameter_size")),
        "quantization": text(details.get("quantization_level")),
    }


@app.get("/llm/ollama/tags")
def llm_ollama_tags():
    """The models pulled on the relay's Ollama server (Ollama's GET /api/tags),
    so the page can check the server answers and offer what it has."""
    server = OLLAMA_SERVER
    if server.base is None:
        return _ollama_unusable(server)
    req = urllib.request.Request(server.base + "/api/tags", method="GET")
    started = time.time()
    try:
        with _ollama_open(req, timeout=OLLAMA_TAGS_TIMEOUT_S) as resp:
            raw = resp.read(OLLAMA_TAGS_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        error = _redirected(server, e) if 300 <= e.code < 400 else _http_error_text(e)
        return {"ok": False, "base": server.base, "status": e.code,
                "elapsed": round(time.time() - started, 1), "error": error}
    except Exception as e:
        return {"base": server.base, **_no_answer(e, started)}
    elapsed = round(time.time() - started, 1)
    listed = None
    if len(raw) <= OLLAMA_TAGS_MAX_BYTES:
        try:
            listed = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError:
            pass
    models = listed.get("models") if isinstance(listed, dict) else None
    if not isinstance(models, list):
        return {"ok": False, "base": server.base, "status": 200, "elapsed": elapsed,
                "error": f"the server at {server.base} did not answer with an Ollama model list "
                         f"(is it Ollama?): {raw[:120].decode('utf-8', errors='replace')!r}"}
    return {"ok": True, "base": server.base, "elapsed": elapsed,
            "models": [_model_entry(m) for m in models[:500]
                       if isinstance(m, dict) and isinstance(m.get("name"), str)]}


class OllamaBaseBody(BaseModel):
    base_url: str


@app.post("/config/ollama-base")
def config_ollama_base(b: OllamaBaseBody):
    """Save the Ollama server for the NEXT start of the backend.

    The relay keeps the server it started with until then: a request that could
    move it at once would be the per-request address this section removed, one
    step removed."""
    try:
        base = ollama_base_from(b.base_url)
    except ValueError as e:
        return JSONResponse({"ok": False, "error": str(e)}, status_code=422)
    with _config_lock:
        try:
            config = read_config(CONFIG_FILE)
        except ConfigUnreadable as e:
            # Not overwritten: it may hold settings someone wrote by hand.
            return JSONResponse({"ok": False, "error": str(e)}, status_code=409)
        config[CONFIG_OLLAMA_KEY] = base
        try:
            replace_file(CONFIG_FILE, json.dumps(config, indent=2, ensure_ascii=False) + "\n")
        except OSError as e:
            return {"ok": False, "error": f"could not write {CONFIG_FILE.name} ({e})"}
    running = OLLAMA_SERVER
    return {
        "ok": True,
        "saved": base,
        "path": str(CONFIG_FILE),
        "active": running.base,
        # Until the backend restarts, the relay keeps sending to `active`.
        "restartRequired": base != running.base,
        # Set when the environment chose this run's server: it will choose the
        # next one too, whatever the file says.
        "overriddenBy": OLLAMA_BASE_ENV if running.source == OLLAMA_BASE_ENV else None,
    }


@app.delete("/memory/{game_key}")
def memory_clear(game_key: str):
    data = _load_all()
    if game_key in data:
        del data[game_key]
        _save_all(data)
    return {"ok": True}


# ── Gamepad emulation (vgamepad) ────────────────────────────────────────────────
# Lets the agent play controller games. Needs `pip install vgamepad` and the free
# ViGEmBus driver (https://github.com/ViGEm/ViGEmBus/releases) on Windows.

_BTN_MAP = {
    # Xbox-style names
    "a": "A", "b": "B", "x": "X", "y": "Y",
    "lb": "LEFT_SHOULDER", "rb": "RIGHT_SHOULDER",
    "ls": "LEFT_THUMB", "rs": "RIGHT_THUMB",
    "start": "START", "back": "BACK", "guide": "GUIDE",
    "up": "DPAD_UP", "down": "DPAD_DOWN", "left": "DPAD_LEFT", "right": "DPAD_RIGHT",
    # Cross-platform / SDL names (as used by the NitroGen dataset) — aliases
    "south": "A", "east": "B", "west": "X", "north": "Y",
    "left_shoulder": "LEFT_SHOULDER", "right_shoulder": "RIGHT_SHOULDER",
    "left_thumb": "LEFT_THUMB", "right_thumb": "RIGHT_THUMB",
    "dpad_up": "DPAD_UP", "dpad_down": "DPAD_DOWN", "dpad_left": "DPAD_LEFT", "dpad_right": "DPAD_RIGHT",
}


def _get_gamepad():
    global _gamepad
    if _gamepad is None:
        _gamepad = vg.VX360Gamepad()
    return _gamepad


def _xusb(short):
    return getattr(vg.XUSB_BUTTON, "XUSB_GAMEPAD_" + _BTN_MAP[short])


class GamepadButtonBody(BaseModel):
    button: str
    hold: float = 0.08


class GamepadStickBody(BaseModel):
    stick: str = "left"
    x: float = 0.0
    y: float = 0.0
    duration: float = 0.0


class GamepadTriggerBody(BaseModel):
    trigger: str = "right"
    value: float = 1.0
    duration: float = 0.1


@app.get("/gamepad/status")
def gamepad_status():
    return {"available": GAMEPAD_AVAILABLE, "connected": _gamepad is not None}


@app.post("/gamepad/button")
def gamepad_button(b: GamepadButtonBody):
    if not GAMEPAD_AVAILABLE:
        return {"ok": False, "available": False,
                "error": "vgamepad not installed (pip install vgamepad + ViGEmBus driver)"}
    key = b.button.strip().lower()
    if key not in _BTN_MAP:
        return {"ok": False, "error": f"unknown button '{b.button}'"}
    hold = _within(b.hold, GAMEPAD_BUTTON_MIN_S, GAMEPAD_HOLD_MAX_S)
    limit = _limit(b.hold, hold, GAMEPAD_BUTTON_MIN_S, GAMEPAD_HOLD_MAX_S, "s")
    try:
        gp = _get_gamepad()
        btn = _xusb(key)

        def press(_):
            gp.press_button(button=btn)
            gp.update()

        def release(_):
            gp.release_button(button=btn)
            gp.update()

        held, halted = _hold_down(press, release, [key], hold)
        return {"ok": True, "held": held, "halted": halted, "limit": limit}
    except Exception as e:
        return {"ok": False, "error": str(e), "limit": limit}


def _stay_or_hold(set_value, value, rest, duration: float) -> dict:
    """Move a stick or trigger to `value` with `set_value`. With a duration of 0
    (or less) it stays there until the next call; with a positive one it is held
    for up to GAMEPAD_HOLD_MAX_S (see _hold) and then set back to `rest`, however
    the hold ends. While input is halted it is not moved at all."""
    applied = _within(duration, 0.0, GAMEPAD_HOLD_MAX_S)
    limit = _limit(duration, applied, 0.0, GAMEPAD_HOLD_MAX_S, "s")
    if _input_halted():
        return {"held": 0.0, "halted": True, "limit": limit}
    set_value(value)
    if applied <= 0:
        return {"held": 0.0, "halted": False, "limit": limit}
    try:
        held, halted = _hold(applied)
    finally:
        set_value(rest)
    return {"held": held, "halted": halted, "limit": limit}


@app.post("/gamepad/stick")
def gamepad_stick(b: GamepadStickBody):
    if not GAMEPAD_AVAILABLE:
        return {"ok": False, "available": False, "error": "vgamepad not installed"}
    try:
        gp = _get_gamepad()
        x = max(-1.0, min(1.0, b.x))
        y = max(-1.0, min(1.0, b.y))
        setter = gp.left_joystick_float if b.stick == "left" else gp.right_joystick_float

        def set_value(v):
            setter(x_value_float=v[0], y_value_float=v[1])
            gp.update()

        return {"ok": True, **_stay_or_hold(set_value, (x, y), (0.0, 0.0), b.duration)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/gamepad/trigger")
def gamepad_trigger(b: GamepadTriggerBody):
    if not GAMEPAD_AVAILABLE:
        return {"ok": False, "available": False, "error": "vgamepad not installed"}
    try:
        gp = _get_gamepad()
        val = max(0.0, min(1.0, b.value))
        setter = gp.left_trigger_float if b.trigger == "left" else gp.right_trigger_float

        def set_value(v):
            setter(value_float=v)
            gp.update()

        return {"ok": True, **_stay_or_hold(set_value, val, 0.0, b.duration)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Native screen capture (dxcam) ───────────────────────────────────────────────
# Optional alternative to the browser's screen-share. Lets the backend grab a game
# window directly. Needs `pip install dxcam` (Windows).

class CaptureSelectBody(BaseModel):
    title: Optional[str] = None
    left: Optional[int] = None
    top: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None


@app.get("/capture/windows")
def capture_windows():
    if not WINDOWS_API:
        return {"ok": False, "error": "pygetwindow unavailable", "windows": []}
    out = []
    try:
        for w in gw.getAllWindows():
            if not (w.title or "").strip():
                continue
            if w.width <= 0 or w.height <= 0:
                continue
            out.append({"title": w.title, "left": w.left, "top": w.top,
                        "width": w.width, "height": w.height})
    except Exception as e:
        return {"ok": False, "error": str(e), "windows": []}
    return {"ok": True, "windows": out}


@app.post("/capture/select")
def capture_select(b: CaptureSelectBody):
    global _capture_region
    left, top, width, height = b.left, b.top, b.width, b.height
    if b.title and WINDOWS_API:
        try:
            wins = gw.getAllWindows()
            matches = [w for w in wins if w.title == b.title]
            if not matches:
                matches = [w for w in wins if b.title.lower() in (w.title or "").lower()]
            if matches:
                w = matches[0]
                left, top, width, height = w.left, w.top, w.width, w.height
        except Exception as e:
            return {"ok": False, "error": str(e)}
    if None in (left, top, width, height):
        left, top, width, height = 0, 0, SCREEN_W, SCREEN_H
    left = max(0, int(left))
    top = max(0, int(top))
    _capture_region = (left, top, left + int(width), top + int(height))
    return {"ok": True, "region": {"left": left, "top": top, "width": int(width), "height": int(height)}}


@app.get("/capture/frame")
def capture_frame():
    global _camera, _capture_region
    if not CAPTURE_AVAILABLE:
        return {"ok": False, "available": False, "error": "dxcam not installed (pip install dxcam)"}
    if Image is None:
        return {"ok": False, "error": "Pillow not installed"}
    try:
        if _camera is None:
            _camera = dxcam.create(output_color="RGB")
        region = _capture_region or (0, 0, SCREEN_W, SCREEN_H)
        frame = None
        for _ in range(5):  # grab() returns None until a new frame is ready
            frame = _camera.grab(region=region)
            if frame is not None:
                break
            time.sleep(0.02)
        if frame is None:
            return {"ok": False, "error": "no frame captured"}
        img = Image.fromarray(frame)
        real_w, real_h = img.width, img.height
        if img.width > MAX_CAP_W:
            new_h = round(img.height * MAX_CAP_W / img.width)
            img = img.resize((MAX_CAP_W, new_h))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {
            "ok": True,
            "image": b64,
            "img_width": img.width,
            "img_height": img.height,
            "real_width": real_w,
            "real_height": real_h,
            "real_left": region[0],
            "real_top": region[1],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Game speed control / pause-to-think (xspeedhack) ────────────────────────────
# Freeze a native game while the (slow) LLM reasons, then resume to act. Works on
# single-player titles that drive physics off the system clock. Needs
# `pip install xspeedhack` (Windows). Do NOT use with anti-cheat / online games.

class AttachBody(BaseModel):
    process: str
    arch: str = "x64"


class SpeedBody(BaseModel):
    speed: float = 1.0


@app.post("/game/attach")
def game_attach(b: AttachBody):
    global _speed_client
    if not SPEEDHACK_AVAILABLE:
        return {"ok": False, "available": False, "error": "xspeedhack not installed"}
    if psutil is None:
        return {"ok": False, "error": "psutil not installed (pip install psutil)"}
    try:
        pid = None
        for p in psutil.process_iter(["pid", "name"]):
            name = (p.info.get("name") or "").lower()
            if name == b.process.lower():
                pid = p.info["pid"]
                break
        if pid is None:
            return {"ok": False, "error": f"process '{b.process}' not found"}
        _speed_client = xsh.Client(process_id=pid, arch=b.arch)
        return {"ok": True, "pid": pid}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/game/speed")
def game_speed(b: SpeedBody):
    if not SPEEDHACK_AVAILABLE or _speed_client is None:
        return {"ok": False, "error": "not attached to a game"}
    try:
        _speed_client.set_speed(max(0.0, b.speed))
        return {"ok": True, "speed": b.speed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/game/detach")
def game_detach():
    global _speed_client
    try:
        if _speed_client is not None:
            try:
                _speed_client.set_speed(1.0)
            except Exception:
                pass
        _speed_client = None
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Game Agent Backend Server")
    print("─" * 40)
    print(f"Platform : {platform.system()}")
    print(f"Screen   : {SCREEN_W} x {SCREEN_H} px")
    print(f"API      : http://localhost:{PORT} (only for the agent page at {PAGE_ORIGINS[0]})")
    print(f"Token    : {'from AGENT_TOKEN' if (os.environ.get('AGENT_TOKEN') or '').strip() else 'new for this start'}, "
          f"written to {TOKEN_FILE.name}")
    print("           A page opened before this start must be reloaded (F5).")
    if OLLAMA_SERVER.base:
        print(f"Ollama   : {OLLAMA_SERVER.base} "
              f"({'the default' if OLLAMA_SERVER.source == 'default' else 'from ' + OLLAMA_SERVER.source}); "
              f"the relay sends model requests only there")
    else:
        print(f"Ollama   : NOT USABLE - {OLLAMA_SERVER.error}.")
        print("           The relay refuses model requests until that is fixed and the backend restarted.")
    print(f"DPI-aware: {'yes' if platform.system() == 'Windows' else 'n/a'}")
    print("Capabilities:")
    print(f"  gamepad  (vgamepad)  : {'ready' if GAMEPAD_AVAILABLE else 'missing — pip install vgamepad + ViGEmBus'}")
    print(f"  capture  (dxcam)     : {'ready' if CAPTURE_AVAILABLE else 'missing — pip install dxcam'}")
    print(f"  windows  (pygetwindow): {'ready' if WINDOWS_API else 'missing — pip install pygetwindow'}")
    print(f"  speedhack(xspeedhack): {'ready' if SPEEDHACK_AVAILABLE else 'missing — pip install xspeedhack'}")
    print()
    print("Move mouse to TOP-LEFT corner to emergency-stop.")
    print("Press Ctrl+C to quit.")
    print()
    # On the socket claimed at the top of this file, before the token was written.
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[_listener])
