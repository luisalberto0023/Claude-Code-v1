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
import functools
import hmac
import ipaddress
import os
import secrets
import socket
import stat
import subprocess
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Literal, NamedTuple, Optional, Tuple, Union, get_args

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
from pydantic import BaseModel, ConfigDict, Field, field_validator
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


class HaltGate:
    """Refuse a request to a route that sends input while input is halted (see
    "Kill switch" below), before the route runs: HTTP 423 with
    {"ok": false, "halted": true, "error": "..."}. The routes it guards are the
    ones declared with @input_route, listed in INPUT_ROUTES.

    A request that got past this a moment before the halt is stopped inside its
    route, which asks _input_halted() before each press, step and click (and, for
    a stick, a trigger or the game speed, again once it is set, to put it back)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if (scope["type"] == "http" and scope["method"] == "POST"
                and scope["path"] in INPUT_ROUTES and _input_halted()):
            await JSONResponse(_halted_reply(), status_code=HALT_STATUS)(scope, receive, send)
            return
        await self.app(scope, receive, send)


app = FastAPI(title="Game Agent Backend")
# No CORS middleware: the page reaches the backend through Vite's proxy, from its
# own origin, so no other origin ever needs to read a reply. CORS allowed every
# origin here before, which let any page read the screen through /capture/frame.
# Added first, so it runs last of these: a request without the token is refused
# for that, and learns nothing about the halt.
app.add_middleware(HaltGate)
app.add_middleware(PageOnly)
# Added after PageOnly, so it runs before it: a request with a hostile Host is
# turned away before anything else looks at it.
app.add_middleware(TrustedHostMiddleware, allowed_hosts=BACKEND_HOSTS)
# Added last, so it wraps both refusals above.
app.add_middleware(BodyReadBeforeRefusal)


# ── Which code this is ─────────────────────────────────────────────────────────
# The test PC gets code only through git pull, and a backend started before a
# pull keeps running the code it started with, while a reloaded page runs the
# new code. That has happened: a fix sat uncommitted on the developer's machine
# while the test PC reported itself up to date. A log that does not say which
# commit wrote it cannot be compared with any other run, or even trusted to be
# the code under test. So the backend reads its commit once, when it starts,
# and says it: in the banner, on GET /health and GET /version, and on every run
# and game record it writes. The page compares it with its own at ▶ Start
# (src/agent/episodes.js), and tools/git-version.mjs reads the page's the same
# way.
#
# One git command gives the commit, the branch and whether tracked files were
# changed since (dirty). Untracked files are not counted: logs/, the token and
# agent-config.json are git-ignored anyway, and a stray new file changes no code
# that runs. --no-optional-locks keeps git from taking the index lock, so a
# backend starting never gets in the way of a git command run at the same time.
# Where git cannot run (not on PATH, a checkout owned by another user), the
# commit is read from .git's own files instead, and dirty is unknown (None).
# Neither working is not an error: the backend starts, and says why it cannot
# tell.

GIT_STATUS_ARGS = ["git", "--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=no"]
GIT_TIMEOUT_S = 5
SHORT_COMMIT = 7  # fixed, so the same commit reads the same on every machine
_COMMIT = re.compile(r"[0-9a-f]{40}|[0-9a-f]{64}")


def parse_git_status(text: str) -> Dict[str, Any]:
    """The commit, branch and dirty flag in `git status --porcelain=v2 --branch`
    output. The commit is None before the first commit, the branch None on a
    detached HEAD."""
    full, branch, dirty = None, None, False
    for line in (text or "").splitlines():
        if line.startswith("# branch.oid "):
            value = line[len("# branch.oid "):].strip()
            full = value if _COMMIT.fullmatch(value) else None
        elif line.startswith("# branch.head "):
            value = line[len("# branch.head "):].strip()
            branch = None if value == "(detached)" else value
        elif line.strip() and not line.startswith("#"):
            dirty = True
    return {"full": full, "branch": branch, "dirty": dirty}


def version_from_files(root: Path) -> Dict[str, Any]:
    """The commit from .git's own files, for when git itself cannot run. Raises
    when they do not name one (no .git folder, a worktree's .git file)."""
    git_dir = root / ".git"
    head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
    branch, full = None, head
    if head.startswith("ref: "):
        ref = head[len("ref: "):].strip()
        branch = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        loose = git_dir / ref
        full = loose.read_text(encoding="utf-8").strip() if loose.is_file() else None
        packed = git_dir / "packed-refs"
        if full is None and packed.is_file():
            for line in packed.read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 2 and parts[1] == ref:
                    full = parts[0]
    if not full or not _COMMIT.fullmatch(full):
        raise ValueError(f"{git_dir} names no commit")
    return {"full": full, "branch": branch, "dirty": None}


def _first_line(text: str) -> str:
    lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
    return lines[0][:200] if lines else ""


def read_version(root: Path, run: Callable = subprocess.run) -> Dict[str, Any]:
    """Which commit `root` is checked out at:
    {commit, commitFull, dirty, branch, source, error}. Never raises: `commit`
    is None and `error` says why when neither git nor .git's files could tell.
    `run` is subprocess.run, or a stand-in in the checks."""
    try:
        done = run(GIT_STATUS_ARGS, cwd=str(root), capture_output=True, text=True, encoding="utf-8",
                   errors="replace", timeout=GIT_TIMEOUT_S,
                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if done.returncode != 0:
            raise RuntimeError(_first_line(done.stderr) or f"git exited with {done.returncode}")
        found = parse_git_status(done.stdout)
        if not found["full"]:
            raise RuntimeError("the checkout has no commit yet")
        source = "git"
    except Exception as e:
        git_error = f"git: {e}" if not isinstance(e, FileNotFoundError) else "git is not on PATH"
        try:
            found = version_from_files(root)
            source = f".git files ({git_error})"
        except Exception as e2:
            return {"commit": None, "commitFull": None, "dirty": None, "branch": None,
                    "source": None, "error": f"{git_error}; {e2}"}
    return {"commit": found["full"][:SHORT_COMMIT], "commitFull": found["full"], "dirty": found["dirty"],
            "branch": found["branch"], "source": source, "error": None}


VERSION = read_version(Path(__file__).parent)
STARTED_AT = datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _version_note(version: Dict[str, Any]) -> str:
    """The version as the banner and the log say it: 842fa64 on <branch>."""
    if not version.get("commit"):
        return f"unknown ({version.get('error')})"
    note = version["commit"] + (f" on {version['branch']}" if version.get("branch") else "")
    if version.get("dirty"):
        note += ", with uncommitted changes to tracked files"
    return note


@app.get("/version")
def version():
    """This backend's commit, read when it started, and when that was."""
    return {**VERSION, "startedAt": STARTED_AT}


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
    # Answers without the token, so it says only that the backend is up, whether
    # input is halted, and which kill-switch hotkeys it registered, none of which
    # is worth anything to another site. The screen size and capabilities it used
    # to include are behind the token, at /screen/info and /capabilities. The
    # commit is worth nothing to another site either (the code is public), and
    # here anyone at the test PC can see which code the backend runs.
    return {"status": "ok", "halted": _input_halted(), "hotkeys": list(HOTKEYS["registered"]),
            "commit": VERSION["commit"], "dirty": VERSION["dirty"]}


@app.get("/capabilities")
def capabilities():
    return _capabilities()


# ── Kill switch ────────────────────────────────────────────────────────────────
# SETUP.md used to say that moving the mouse into a screen corner kills all input.
# It never did. That is pyautogui's fail-safe, and it stops only pyautogui's own
# calls: keys go out through SendInput and the gamepad through vgamepad, and
# neither asks pyautogui anything. ■ Stop only stopped the page asking for more,
# so a hold, a drag or a line of typing already sent ran to its end. Unattended
# play on a game nobody has vetted is acceptable only if a person can stop it at
# once, so input has a halt flag:
#   - it is set by a global hotkey, Ctrl+Alt+Pause or Ctrl+Alt+Shift+H (many
#     laptops have no Pause key), which works over most windows but not all (see
#     "Kill-switch hotkeys"); by the page's ■ Stop; or by POST /session/halt,
#   - when it is set, every key and mouse button the backend holds down is let
#     go, the virtual gamepad is put back to rest, and a game slowed by the speed
#     hack runs at normal speed again,
#   - while it is set, every route declared with @input_route refuses with HTTP
#     423 (HaltGate), and a hold, a pointer glide, a run of clicks or a line of
#     typing already under way stops within HOLD_STEP_S,
#   - only POST /session/resume clears it. No hotkey resumes, so a stray key
#     press cannot set the agent going again. The page's Resume button sends it,
#     and its ■ Stop lifts only the halt Stop itself set, once the run has ended.
# GET /health says whether input is halted and which hotkeys registered.

HALT_STATUS = 423  # "Locked"
# Who can halt: a hotkey, the page (POST /session/halt), or the page's ■ Stop.
HALT_REASONS = ("hotkey", "page", "stop")
_HALTED_BY = {"page": "the agent page", "stop": "■ Stop on the agent page"}

_halted = threading.Event()
_halt_lock = threading.Lock()
_halt_reasons: Dict[str, str] = {}   # reason -> who, for people, oldest first
_halt_since: Optional[str] = None


def _input_halted() -> bool:
    """Whether injected input has been told to stop. Every hold, pointer glide,
    run of clicks and line of typing asks this before each press and step."""
    return _halted.is_set()


def _announce(text: str) -> None:
    """A line in the backend window, with the time (the checks silence it). A
    window that cannot show a character, or has gone, must not fail a halt."""
    try:
        print(f"[{datetime.datetime.now():%H:%M:%S}] {text}", flush=True)
    except Exception:
        pass


# What the backend has pressed and not let go of yet, so a halt can let go of it
# at once rather than when the hold notices: (kind, key) -> how to let it go.
# A hold adds a key before pressing it and takes it out once it is up again; a
# release that failed stays here, so the next halt tries again.
_held: Dict[Tuple[str, Any], Callable[[], None]] = {}
_held_lock = threading.Lock()


def _pressing(kind: str, key: Any, release: Callable[[], None]) -> None:
    with _held_lock:
        _held[(kind, key)] = release


def _let_go(kind: str, key: Any) -> None:
    with _held_lock:
        _held.pop((kind, key), None)


def _let_go_of_everything() -> Dict[str, Any]:
    """Let go of every key, button and mouse button the backend holds, put the
    virtual gamepad back to rest and a slowed game back to normal speed. Each
    step is tried whatever the others do; what failed is reported, not raised.
    Letting go of something already up does no harm."""
    with _held_lock:
        held = list(_held.items())
    let_go, errors = [], []
    for (kind, key), release in reversed(held):
        try:
            release()
            _let_go(kind, key)
            let_go.append(f"{kind} {key}")
        except Exception as e:
            errors.append(f"letting go of {kind} {key}: {e}")
    gamepad = speed = False
    if _gamepad is not None:
        try:
            _gamepad.reset()
            _gamepad.update()
            gamepad = True
        except Exception as e:
            errors.append(f"resetting the gamepad: {e}")
    if _speed_client is not None:
        try:
            _speed_client.set_speed(1.0)
            speed = True
        except Exception as e:
            errors.append(f"setting the game back to normal speed: {e}")
    return {"keys": let_go, "gamepad": gamepad, "speed": speed, "errors": errors}


def halt_state() -> Dict[str, Any]:
    """Whether input is halted, why and since when, and the kill-switch hotkeys."""
    with _halt_lock:
        halted = _halted.is_set()
        reasons = list(_halt_reasons)
        # Who halted it, for people: the last to, not counting ■ Stop when
        # someone else did too (Stop's halt lifts itself; theirs is what stays).
        by = [who for reason, who in _halt_reasons.items() if reason != "stop"] or list(_halt_reasons.values())
        since = _halt_since
    return {"halted": halted, "reasons": reasons, "by": by[-1] if by else None, "since": since,
            "hotkeys": list(HOTKEYS["registered"]), "hotkeyProblems": list(HOTKEYS["problems"])}


def halt_input(reason: str, who: str) -> Dict[str, Any]:
    """Halt injected input, then let go of everything held. The flag goes up
    first, so nothing is pressed again behind the release. Safe to call again
    while halted, from any thread: it lets go again."""
    global _halt_since
    with _halt_lock:
        if not _halted.is_set():
            _halt_since = datetime.datetime.now().isoformat(timespec="seconds")
        _halt_reasons.pop(reason, None)
        _halt_reasons[reason] = who
        _halted.set()
    let_go = _let_go_of_everything()
    _announce(f"Input HALTED by {who}: everything held was let go, and no key, click or "
              f"gamepad input is sent until Resume on the agent page.")
    for error in let_go["errors"]:
        _announce(f"  could not finish {error}")
    return {**halt_state(), "letGo": let_go}


def resume_input(reason: Optional[str] = None) -> Dict[str, Any]:
    """Lift the halt: every reason for it, or with `reason` only that one (the
    page's ■ Stop lifting its own halt once its run has ended, which leaves a
    halt someone set by hotkey in place)."""
    global _halt_since
    with _halt_lock:
        was_halted = _halted.is_set()
        if reason is None:
            _halt_reasons.clear()
        else:
            _halt_reasons.pop(reason, None)
        if not _halt_reasons:
            _halted.clear()
            _halt_since = None
        lifted = was_halted and not _halted.is_set()
    if lifted:
        _announce("Input resumed.")
    return halt_state()


def _halted_reply(**extra) -> Dict[str, Any]:
    """The reply to input not sent, or not finished, because input is halted."""
    who = halt_state()["by"] or "the kill switch"
    return {"ok": False, "halted": True,
            "error": f"input is halted by {who}: nothing more is sent, and anything held was let go, "
                     f"until Resume is pressed on the agent page", **extra}


class HaltBody(BaseModel):
    reason: Literal["page", "stop"] = "page"


class ResumeBody(BaseModel):
    # None lifts every halt (the page's Resume button). "stop" lifts only the one
    # ■ Stop set, once the run has ended.
    reason: Optional[Literal["page", "stop"]] = None


@app.get("/session/state")
def session_state():
    return halt_state()


@app.post("/session/halt")
def session_halt(b: HaltBody):
    return {"ok": True, **halt_input(b.reason, _HALTED_BY[b.reason])}


@app.post("/session/resume")
def session_resume(b: ResumeBody):
    return {"ok": True, **resume_input(b.reason)}


# Every route that moves the mouse, presses a key, drives the gamepad or reaches
# into the game is declared with @input_route rather than @app.post, which lists
# it here for HaltGate (tools/check_backend.py fails on one that is not).
INPUT_ROUTES = set()


def input_route(path: str):
    INPUT_ROUTES.add(path)
    return app.post(path)


# ── Kill-switch hotkeys ────────────────────────────────────────────────────────
# Windows' RegisterHotKey, on a thread of its own: a hotkey arrives as a message
# for the thread that registered it, so that thread does nothing but wait for
# messages. MOD_NOREPEAT: a chord held down halts once, not twenty times a second.
# What a hotkey does not do, and SETUP.md says so: the window in front still gets
# Ctrl, Alt and Shift (only the last key, Pause or H, is kept from it); a program
# in front that reads the keyboard as raw input with RIDEV_NOHOTKEYS, as some
# games do, turns every such hotkey off while it has focus (Alt+Tab still works,
# and ■ Stop on the agent page is the way then); and over Remote Desktop the
# local client takes Ctrl+Alt+Break for itself.
MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_NOREPEAT = 0x0001, 0x0002, 0x0004, 0x4000
VK_CANCEL, VK_PAUSE = 0x03, 0x13
WM_HOTKEY = 0x0312
ERROR_HOTKEY_ALREADY_REGISTERED = 1409
# (the chord as people press it, the modifier sets it is registered with, its
# virtual keys). A hotkey fires only on its exact modifiers, and a key the agent
# is holding counts: Ctrl+Alt+Pause pressed while the agent holds Shift arrives
# as Ctrl+Alt+Shift+Pause, so it is registered that way too (Ctrl+Alt+Shift+H
# has Shift already, and a held Ctrl or Alt changes neither). With Ctrl held
# down, most keyboards send Pause as Break (VK_CANCEL), so that chord is both.
# The first modifier set with the first virtual key is the chord as a person
# presses it, so the chord counts as registered only when that one is: Ctrl+Alt
# with Pause itself would never fire from such a keyboard.
HALT_HOTKEYS = (
    ("Ctrl+Alt+Pause", (MOD_CONTROL | MOD_ALT, MOD_CONTROL | MOD_ALT | MOD_SHIFT), (VK_CANCEL, VK_PAUSE)),
    ("Ctrl+Alt+Shift+H", (MOD_CONTROL | MOD_ALT | MOD_SHIFT,), (ord("H"),)),
)
# Which chords registered, and why any did not (start_halt_hotkeys fills it in).
HOTKEYS: Dict[str, List[str]] = {"registered": [], "problems": []}


def _on_hotkey(chord: str) -> None:
    """What pressing a kill-switch chord does: halt input. It never resumes."""
    halt_input("hotkey", chord)


class _Win32Hotkeys:
    """The two Windows calls the hotkey thread makes (the checks stand in for
    them, so that thread's loop can be run without registering anything)."""

    def __init__(self):
        import ctypes
        from ctypes import wintypes
        self._ctypes = ctypes
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._user32.RegisterHotKey.argtypes = (wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT)
        self._user32.RegisterHotKey.restype = wintypes.BOOL
        self._user32.GetMessageW.argtypes = (ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT)
        self._user32.GetMessageW.restype = wintypes.BOOL
        self._msg = wintypes.MSG()

    def register(self, hotkey_id: int, modifiers: int, vk: int) -> int:
        """0 once registered, else the Windows error code."""
        if self._user32.RegisterHotKey(None, hotkey_id, modifiers, vk):
            return 0
        return self._ctypes.get_last_error() or -1

    def next_hotkey(self) -> Optional[int]:
        """Wait for the next hotkey this thread registered, and return its id;
        None if the thread's message loop has ended."""
        while self._user32.GetMessageW(self._ctypes.byref(self._msg), None, 0, 0) > 0:
            if self._msg.message == WM_HOTKEY:
                return int(self._msg.wParam)
        return None


def _hotkey_loop(ready: threading.Event, api=None) -> None:
    """Register the kill-switch chords, say which took (HOTKEYS, then `ready`),
    and halt input each time one is pressed, for as long as the backend runs."""
    chords: Dict[int, str] = {}
    registered: List[str] = []
    problems: List[str] = []
    try:
        api = api or _Win32Hotkeys()
        hotkey_id = 0
        for name, modifier_sets, keys in HALT_HOTKEYS:
            as_pressed = -1  # the error registering the chord as people press it; 0 once it took
            for n, modifiers in enumerate(modifier_sets):
                for k, vk in enumerate(keys):
                    hotkey_id += 1
                    error = api.register(hotkey_id, modifiers | MOD_NOREPEAT, vk)
                    if not error:
                        chords[hotkey_id] = name
                    # The first set with the first key is the chord as people
                    # press it (see HALT_HOTKEYS); the others only cover a key
                    # the agent holds, or a keyboard that sends Pause with Ctrl.
                    if n == 0 and k == 0:
                        as_pressed = error
            if not as_pressed:
                registered.append(name)
            elif as_pressed == ERROR_HOTKEY_ALREADY_REGISTERED:
                problems.append(f"{name} is taken by another program")
            else:
                problems.append(f"{name} could not be registered (Windows error {as_pressed})")
    except Exception as e:
        problems.append(f"the hotkeys could not be set up ({e})")
    finally:
        HOTKEYS.update(registered=registered, problems=problems)
        ready.set()
    while chords:
        hotkey_id = api.next_hotkey()
        if hotkey_id is None:
            return
        if hotkey_id in chords:
            try:
                _on_hotkey(chords[hotkey_id])
            except Exception as e:
                _announce(f"Kill switch: halting input failed: {e}")


def start_halt_hotkeys(timeout: float = 5.0) -> Dict[str, List[str]]:
    """Start the hotkey thread and wait until it says which chords registered.
    Skipped while the backend checks run (AGENT_TEST=1): a global hotkey is a
    side effect on whatever machine runs them."""
    if os.environ.get("AGENT_TEST") == "1":
        HOTKEYS.update(registered=[], problems=["not registered while the backend checks run (AGENT_TEST=1)"])
        return HOTKEYS
    if platform.system() != "Windows":
        HOTKEYS.update(registered=[], problems=["global hotkeys are only set up on Windows"])
        return HOTKEYS
    ready = threading.Event()
    threading.Thread(target=_hotkey_loop, args=(ready,), name="kill-switch-hotkeys", daemon=True).start()
    if not ready.wait(timeout):
        HOTKEYS.update(registered=[], problems=["the hotkey thread did not answer"])
    return HOTKEYS


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


@input_route("/mouse/move")
def mouse_move(b: MoveBody):
    try:
        x, y = _on_screen(b.x, b.y)
        if _glide(x, y, b.duration):
            return _halted_reply()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# The gap between the clicks of a double (or triple) click, as pyautogui's own.
CLICK_INTERVAL_S = 0.05


@input_route("/mouse/click")
def mouse_click(b: ClickBody):
    try:
        x, y = _on_screen(b.x, b.y)
        if _glide(x, y, b.move_duration):
            return _halted_reply()
        # One click at a time, as pyautogui.click(clicks=n) makes them, so a halt
        # between two stops the rest.
        for i in range(b.clicks):
            if i:
                _wait(CLICK_INTERVAL_S)
            if _input_halted():
                return _halted_reply(clicked=i)
            pyautogui.click(button=b.button)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@input_route("/mouse/drag")
def mouse_drag(b: DragBody):
    try:
        # Both ends are checked before the pointer moves at all: a drag whose end
        # is off-screen would otherwise start, press the button and finish in a
        # corner, which is pyautogui's abort signal (see _on_screen).
        x1, y1 = _on_screen(b.x1, b.y1)
        x2, y2 = _on_screen(b.x2, b.y2)
        if _glide(x1, y1, 0.1) or _drag_to(x2, y2, b.duration, b.button):
            return _halted_reply()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@input_route("/mouse/scroll")
def mouse_scroll(b: ScrollBody):
    try:
        x, y = _on_screen(b.x, b.y)
        if _glide(x, y, 0.05) or _input_halted():
            return _halted_reply()
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
#     so input that has been told to stop (see "Kill switch") is let go within a
#     step, and a hold asked for while it is halted presses nothing,
#   - whatever goes down comes back up, even when a step raises, and a pyautogui
#     key-up goes through even while the mouse is in a screen corner,
#   - at most TYPE_TEXT_MAX_CHARS characters are typed per call, TYPE_INTERVAL_MAX_S
#     apart at most, so a call to type text ends within a minute; they are typed
#     a few at a time, so a halt stops the rest,
#   - the pointer glides in steps of MOUSE_STEP_S, asking _input_halted() before
#     each, for at most MOUSE_MOVE_MAX_S, and a drag lets its button go however
#     it ends.
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
# pyautogui glides the pointer in steps of this length too (its MINIMUM_SLEEP),
# and makes a move of 0.1 s or less (its MINIMUM_DURATION) one jump. The page
# asks for at most a second (a drag with the Slow timing); a pointer glide or a
# drag is cut to MOUSE_MOVE_MAX_S, where pyautogui used to try any length asked.
MOUSE_STEP_S = 0.05
MOUSE_JUMP_MAX_S = 0.1
MOUSE_MOVE_MAX_S = 5.0


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
    refuses every call while the mouse is in a screen corner (its fail-safe), a
    key-up included, which would leave the key down for good at the moment
    someone moved the mouse there to stop it. A key-up refused that way goes
    straight to pyautogui's platform layer, which does not check; new presses
    are still refused."""
    try:
        pyautogui.keyUp(key)
    except pyautogui.FailSafeException:
        pyautogui.platformModule._keyUp(key)


def _mouse_up(button: str) -> None:
    """pyautogui's mouseUp, going through even while the mouse sits in a screen
    corner, as _pyautogui_key_up does for keys."""
    try:
        pyautogui.mouseUp(button=button)
    except pyautogui.FailSafeException:
        x, y = pyautogui.position()
        pyautogui.platformModule._mouseUp(x, y, button)


def _hold_down(press, release, keys: list, seconds: float, kind: str = "key") -> Tuple[float, bool]:
    """Press `keys` in order, hold them for `seconds` (see _hold), and release them
    in reverse order. Every key it tried to press is released, whatever happens in
    between: a press or a step that raises, or a halt. That includes a press that
    raised part-way, which may have gone down (a gamepad button set but its report
    not sent); letting go of a key that is up does no harm, and a key left down
    would stay down. A release that raises does not stop the others; the first
    such error is raised once all were tried.

    Each key is in _held, under (kind, key), from just before it is pressed until
    it is up again, so a halt can let go of it at once.

    While input is halted it presses nothing more, and returns (0.0, True)."""
    if _input_halted():
        return 0.0, True
    pressed = []
    try:
        for k in keys:
            if _input_halted():
                return 0.0, True
            pressed.append(k)
            _pressing(kind, k, functools.partial(release, k))
            press(k)
        return _hold(seconds)
    finally:
        failed = None
        for k in reversed(pressed):
            try:
                release(k)
                _let_go(kind, k)
            except Exception as e:
                failed = failed or e
        if failed is not None:
            raise failed


def _glide(x: int, y: int, duration: float) -> bool:
    """Move the pointer to (x, y) in a straight line over `duration` seconds (at
    most MOUSE_MOVE_MAX_S), as pyautogui.moveTo does, asking _input_halted()
    before each step. Returns True if input was halted, before the move or
    part-way through it.

    A move short enough for pyautogui to make in one jump is left to it, as it
    always was; a longer one is made here in pyautogui's steps, so that it can be
    stopped between them."""
    if _input_halted():
        return True
    if not duration > MOUSE_JUMP_MAX_S:
        pyautogui.moveTo(x, y, duration=duration)
        return False
    seconds = min(duration, MOUSE_MOVE_MAX_S)
    steps = max(1, math.ceil(seconds / MOUSE_STEP_S - 1e-9))
    x0, y0 = pyautogui.position()
    for i in range(1, steps + 1):
        _wait(seconds / steps)
        if _input_halted():
            return True
        pyautogui.moveTo(round(x0 + (x - x0) * i / steps), round(y0 + (y - y0) * i / steps))
    return False


def _drag_to(x: int, y: int, duration: float, button: str) -> bool:
    """Press `button`, glide to (x, y), and let the button go however that ends:
    pyautogui.dragTo's three parts (on Windows it is exactly these), taken apart
    so a halt stops the glide and the button is in _held meanwhile. Returns True
    if input was halted."""
    if _input_halted():
        return True
    _pressing("mouse", button, functools.partial(_mouse_up, button))
    try:
        pyautogui.mouseDown(button=button)
        return _glide(x, y, duration)
    finally:
        _mouse_up(button)
        _let_go("mouse", button)


def _type_in_pieces(text: str, interval: float) -> int:
    """Type `text` with pyautogui.typewrite, `interval` seconds after each
    character as before, a few characters at a time: each piece takes about
    HOLD_STEP_S (or is one character, when they are further apart than that),
    and _input_halted() is asked before each. Returns how many characters were
    typed."""
    size = len(text) if interval <= 0 else max(1, int(HOLD_STEP_S / interval + 1e-9))
    typed = 0
    while typed < len(text):
        if _input_halted():
            break
        piece = text[typed:typed + size]
        pyautogui.typewrite(piece, interval=interval)
        typed += len(piece)
    return typed


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


# The agent must never press a kill-switch chord itself. Windows matches injected
# keys against a hotkey as it does a person's, so press_key or hold_key with
# Ctrl+Alt+Shift+H (which a model can be talked into by what the screen says)
# would halt the agent's own input, and an unattended run would sit there until
# someone pressed Resume. Key names that stand for a chord's key, beyond the
# chord's own names (HALT_HOTKEYS): AltGr (altright) is Ctrl+Alt on many layouts.
_AS_CHORD_KEY = {
    "ctrlleft": ("ctrl",), "ctrlright": ("ctrl",),
    "altleft": ("alt",), "altright": ("alt", "ctrl"),
    "shiftleft": ("shift",), "shiftright": ("shift",),
    "break": ("pause",),
}


def _kill_chord_in(keys: list) -> Optional[str]:
    """The kill-switch chord that pressing `keys` would make, counting the keys
    the backend holds down at that moment (another request's hold), or None."""
    names = set(keys)
    scan_names = {code: name for name, code in globals().get("_SCAN", {}).items()}
    with _held_lock:
        held = list(_held)
    for kind, key in held:
        if kind == "key":
            names.add(key)
        elif kind == "scan":
            names.add(scan_names.get(key, ""))
    down = {k for name in names for k in _AS_CHORD_KEY.get(name, (name,))}
    for chord, _, _ in HALT_HOTKEYS:
        if set(chord.lower().split("+")) <= down:
            return chord
    return None


def _kill_chord_refusal(keys: list) -> Optional[str]:
    """The error for keys that would press a kill-switch chord, or None."""
    chord = _kill_chord_in(keys)
    if chord is None:
        return None
    return (f"{chord} is the operator's kill switch, and the agent never presses it: it would halt "
            f"all of the agent's input until a person pressed Resume")


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


@input_route("/keyboard/press")
def key_press(b: KeyPressBody):
    keys = _parse_key(b.key)
    if not keys:
        return {"ok": False, "error": f"no key to press in {b.key!r}"}
    refused = _kill_chord_refusal(keys)
    if refused:
        return {"ok": False, "error": refused}
    try:
        focus = _active_window_title()
        hold = _within(b.hold, 0.0, 2.0)
        # A press is a short hold: modifiers down in order, then the key, and all
        # of them up in reverse, whatever happens in between (see _hold_down).
        # Preferred path: SendInput with hardware scan codes (correct extended-key
        # handling; works with browsers AND DirectInput games).
        scans = [_scan_for(k) for k in keys]
        if all(s is not None for s in scans):
            method = "sendinput"
            _, halted = _hold_down(_send_scan, lambda s: _send_scan(s, keyup=True), scans, hold, kind="scan")
        else:
            # Fallback: pyautogui (non-Windows, or a key we have no scan code for)
            method = "pyautogui"
            _, halted = _hold_down(pyautogui.keyDown, _pyautogui_key_up, keys, hold)
        if halted:
            return _halted_reply(focus=focus, method=method)
        return {"ok": True, "focus": focus, "held": hold, "method": method}
    except Exception as e:
        return {"ok": False, "error": str(e), "focus": _active_window_title()}


@input_route("/keyboard/hold")
def key_hold(b: HoldBody):
    duration = _within(b.duration, 0.0, KEY_HOLD_MAX_S)
    limit = _limit(b.duration, duration, 0.0, KEY_HOLD_MAX_S, "s")
    keys = _parse_key(b.key)
    if not keys:
        return {"ok": False, "error": f"no key to hold in {b.key!r}", "limit": limit}
    refused = _kill_chord_refusal(keys)
    if refused:
        return {"ok": False, "error": refused, "limit": limit}
    try:
        scans = [_scan_for(k) for k in keys]
        if all(s is not None for s in scans):
            method = "sendinput"
            held, halted = _hold_down(_send_scan, lambda s: _send_scan(s, keyup=True), scans, duration, kind="scan")
        else:
            method = "pyautogui"
            held, halted = _hold_down(pyautogui.keyDown, _pyautogui_key_up, keys, duration)
        return {"ok": True, "method": method, "held": held, "halted": halted, "limit": limit}
    except Exception as e:
        return {"ok": False, "error": str(e), "limit": limit}


@input_route("/keyboard/type")
def key_type(b: TypeBody):
    text = b.text[:TYPE_TEXT_MAX_CHARS]
    limit = _limit(len(b.text), len(text), 0, TYPE_TEXT_MAX_CHARS, "characters")
    interval = _within(b.interval, 0.0, TYPE_INTERVAL_MAX_S)
    try:
        if all(ord(c) < 128 for c in text):
            typed = _type_in_pieces(text, interval)
            if typed < len(text):
                return _halted_reply(typed=typed, limit=limit)
        elif _input_halted():
            return _halted_reply(typed=0, limit=limit)
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


# The longest window title handed to the page. Titles are short; this only keeps
# a strange one from filling a reply.
FOREGROUND_TITLE_MAX = 512


@app.get("/screen/foreground")
def screen_foreground():
    """The title of the window in front, and nothing else.

    The page checks it against sites whose rules forbid automated play
    (src/agent/sitePolicy.js): at Start, and every few seconds during a run,
    when the window in front is whatever the agent last clicked. It is only
    read: no window is focused, moved or shown. A title can say what someone is
    doing in another window, so the page logs one only when it names a blocked
    site, and this route needs the launch token like every other."""
    return {
        "ok": True,
        "title": _active_window_title()[:FOREGROUND_TITLE_MAX],
        "available": platform.system() == "Windows",
    }


# ── Session log files ──────────────────────────────────────────────────────────
# The in-page log is capped and lives only in browser memory, so a long run loses
# its early history and a crashed tab loses everything. Every line is mirrored to
# a file here so the full run is always available for troubleshooting.
#
# logs/ in the project folder, unless AGENT_LOG_DIR names another folder (a path
# relative to the project folder is taken from there, whatever folder the backend
# was started in, and a leading ~ alone or before a slash is the home folder).
# `npm run episodes` reads the variable the same way (defaultFile in
# tools/episodes.mjs), so it must stay this simple: expanduser would also read
# ~name as another user's home, which that does not. The checks point it at a
# temporary folder, so they never write into the real logs/.

LOG_DIR_ENV = "AGENT_LOG_DIR"


def log_dir_from(environ, root: Path) -> Path:
    value = (environ.get(LOG_DIR_ENV) or "").strip()
    if not value:
        return root / "logs"
    if value == "~" or value[:2] in ("~/", "~\\"):
        return Path.home() / value[2:]
    path = Path(value)
    return path if path.is_absolute() else root / path


LOG_DIR = log_dir_from(os.environ, Path(__file__).parent)

# What one request may add to a session log or a snapshot. Far above what the
# page sends (it flushes every 2 s, in batches it splits to fit: logBatches in
# src/agent/backend.js holds the same two log limits, and tools/check-agent.mjs
# fails if they differ), so these only stop a runaway or a hostile request from
# filling the disk in one go.
LOG_APPEND_MAX_LINES = 1000
LOG_APPEND_MAX_BYTES = 1024 * 1024
SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024


def _too_large(what: str, limit: str) -> JSONResponse:
    # tooLarge tells the page not to send the same request again: it would be
    # refused again (src/agent/logQueue.js).
    return JSONResponse({"ok": False, "tooLarge": True, "error": f"{what} is over the limit of {limit}; nothing was written"},
                        status_code=413)


class LogLines(BaseModel):
    session: str
    lines: List[str]


def _safe_session(session: str) -> str:
    """A session name as a file name: letters, digits, - and _ only, so no
    request can name a file outside the log folder."""
    return re.sub(r"[^A-Za-z0-9_-]+", "-", session)[:80] or "session"


def _log_path(session: str) -> Path:
    return LOG_DIR / f"agent-{_safe_session(session)}.log"


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
    _keep_logs_in_budget(b.session)
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
#
# A frame comes as a PNG (a capture the page drew on a canvas: the solver's, at
# full resolution) or as a JPEG (the frame the model was sent, kept exactly as
# sent; the page tags those "lowres"). It is written as .png or .jpg to match.


class Snapshot(BaseModel):
    session: str
    tag: str
    png: Optional[str] = None     # base64, without the data: prefix
    jpeg: Optional[str] = None    # base64, without the data: prefix
    text: Optional[str] = None


@app.post("/log/snapshot")
def log_snapshot(b: Snapshot):
    # Measured before decoding, so an oversized image is never decoded or written.
    # Four base64 characters carry at most three bytes. The page measures the
    # same way before it sends (snapshotBytes in src/agent/backend.js), and
    # scales a frame down to fit rather than lose it.
    size = (len(b.png or "") + len(b.jpeg or "")) * 3 // 4 + len((b.text or "").encode("utf-8", "replace"))
    if size > SNAPSHOT_MAX_BYTES:
        return _too_large(f"a snapshot of about {size} bytes", f"{SNAPSHOT_MAX_BYTES} bytes")
    _keep_logs_in_budget(b.session)
    try:
        stamp = datetime.datetime.now().strftime("%H%M%S")
        safe_tag = re.sub(r"[^A-Za-z0-9_-]+", "-", b.tag)[:40] or "snap"
        folder = LOG_DIR / "snapshots" / _safe_session(b.session)
        folder.mkdir(parents=True, exist_ok=True)
        written = []
        for image, extension in ((b.png, "png"), (b.jpeg, "jpg")):
            if image:
                path = folder / f"{stamp}-{safe_tag}.{extension}"
                path.write_bytes(base64.b64decode(image))
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


# ── Log folder budget ──────────────────────────────────────────────────────────
# Every run adds a log, turn records, a run record and snapshots, and nothing
# ever deleted any of them: a test PC left playing for days fills its disk. So
# the sessions' files are kept within a budget of AGENT_LOG_BUDGET_MB megabytes
# (LOG_BUDGET_DEFAULT_MB unless it is set; 0 for no limit). At most once every
# LOG_PRUNE_EVERY_S, a write to the log folder starts a look, on a thread of its
# own, that adds up the sessions' files and, when they are over the budget,
# deletes whole sessions, oldest first (by the newest file each holds), until
# the rest fit. On its own thread because a full folder is tens of thousands of
# files, which take seconds to add up and longer to delete, and the games loop
# waits on a snapshot's write.
#
# A session's files are the ones the routes above and below write for it, and
# only those, named as they name them:
#   agent-<session>.log            snapshots/<session>/<HHMMSS>-<tag>.png|.jpg|.txt
#   turns/<session>.jsonl          runs/<session>/run.json (and its .tmp while written)
# where <session> is shaped as the page names a run (runSessionId in
# src/agent/episodes.js, 2026-09-24-10-00-00-abcd; before 793ed82 it had no
# four hex digits). AGENT_LOG_DIR can point at any folder, and another tool's
# runs/ or snapshots/ there (TensorBoard's, a VM's) must never be taken for the
# agent's: a name shaped any other way, a file the backend does not write, a
# subfolder and a link are neither counted nor deleted, and a session's folder
# goes only once nothing is left in it. Nor is episodes.jsonl, which holds one
# line per game of every run (what `npm run episodes` adds up; a line can
# outlive the snapshots it names).
#
# Never deleted, whatever the budget: the session the write is for, and every
# session written to in the last LOG_ACTIVE_S. That keeps the run under way, and
# a run that just ended whose queued lines are still arriving. A session whose
# files could not all be deleted (held open by a viewer, read-only) is left out
# for LOG_RETRY_S, so the backend window does not report it every minute. When
# what is kept is over the budget, the backend window says so once, and why.

LOG_BUDGET_ENV = "AGENT_LOG_BUDGET_MB"
LOG_BUDGET_DEFAULT_MB = 2048
LOG_PRUNE_EVERY_S = 60
LOG_ACTIVE_S = 10 * 60
LOG_RETRY_S = 10 * 60
MB = 1024 * 1024


class LogBudget(NamedTuple):
    bytes: Optional[int]   # None: no limit
    source: str            # "default", or LOG_BUDGET_ENV when that set it
    error: Optional[str]   # why LOG_BUDGET_ENV was not used, when it was set but unusable


def log_budget_from(environ) -> LogBudget:
    """The budget from the environment. A value that is not a number of
    megabytes falls back to the default, and says why."""
    default = LogBudget(LOG_BUDGET_DEFAULT_MB * MB, "default", None)
    value = (environ.get(LOG_BUDGET_ENV) or "").strip()
    if not value:
        return default
    try:
        mb = float(value)
    except ValueError:
        mb = float("nan")
    if not math.isfinite(mb) or mb < 0:
        return default._replace(error=f"{LOG_BUDGET_ENV}={value!r} is not a number of megabytes (0 for no limit)")
    if mb == 0:
        return LogBudget(None, LOG_BUDGET_ENV, None)
    return LogBudget(max(1, int(mb * MB)), LOG_BUDGET_ENV, None)


def budget_note(budget: LogBudget) -> str:
    """The banner's words for the budget."""
    if budget.bytes is None:
        return f"No size limit ({LOG_BUDGET_ENV}=0): old runs' files are never deleted."
    size = f"{budget.bytes / MB:g} MB"
    if budget.error:
        return f"Kept within {size}: {budget.error}, so the default is used."
    if budget.source == LOG_BUDGET_ENV:
        return f"Kept within {size} (from {LOG_BUDGET_ENV}): past it, the oldest runs' files are deleted."
    return f"Kept within {size}: past it, the oldest runs' files are deleted ({LOG_BUDGET_ENV} sets it)."


LOG_BUDGET = log_budget_from(os.environ)

# A run's name as the page makes it (runSessionId), which _safe_session leaves
# as it is, or as it was before 793ed82. ASCII digits only.
_SESSION_ID = r"[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-[0-9a-f]{4})?"
_SESSION_NAME = re.compile(rf"^{_SESSION_ID}$")
_SESSION_LOG = re.compile(rf"^agent-({_SESSION_ID})\.log$")
_SESSION_TURNS = re.compile(rf"^({_SESSION_ID})\.jsonl$")
# The files the backend writes into a session's folders: /log/snapshot's
# <HHMMSS>-<tag> frames and texts, and /episode/run's run.json with the
# temporary file replace_file writes it through.
_SESSION_FOLDERS = (("snapshots", re.compile(r"^[0-9]{6}-[A-Za-z0-9_-]+\.(?:png|jpg|txt)$")),
                    ("runs", re.compile(r"^run\.json(?:\.[0-9]+\.tmp)?$")))


def _entries(folder) -> list:
    try:
        with os.scandir(folder) as found:
            return list(found)
    except OSError:
        return []


# What a link is on Windows: a symbolic link, or a junction (a folder link any
# user can make). DirEntry.is_junction only exists from Python 3.12, and the
# test PC's .venv is whatever Python start.bat found, so the reparse tag is read
# instead. On Windows the directory listing carries it, so a folder of tens of
# thousands of snapshots is not looked at file by file. Other reparse points (a
# OneDrive placeholder, say) are ordinary files and folders here.
_LINK_TAGS = (getattr(stat, "IO_REPARSE_TAG_SYMLINK", 0xA000000C),
              getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003))


def _entry_stat(entry):
    """lstat for a directory entry, or None for a link or something that cannot
    be read: neither is counted, followed or deleted."""
    try:
        if entry.is_symlink():
            return None
        st = entry.stat(follow_symlinks=False)
    except OSError:
        return None
    return None if getattr(st, "st_reparse_tag", 0) in _LINK_TAGS else st


def log_sessions(log_dir: Path) -> Dict[str, Dict[str, Any]]:
    """Every session's files in the log folder, the ones the backend wrote and
    nothing else: {session: {"items": [(path, bytes)], "folders": [path],
    "bytes": total, "newest": mtime}}. "folders" are the session's snapshots/
    and runs/ folders, removed once empty."""
    sessions: Dict[str, Dict[str, Any]] = {}

    def session(name: str) -> Dict[str, Any]:
        return sessions.setdefault(name, {"items": [], "folders": [], "bytes": 0, "newest": 0.0})

    def add(name: str, entry) -> bool:
        st = _entry_stat(entry)
        if st is None or not stat.S_ISREG(st.st_mode):
            return False
        s = session(name)
        s["items"].append((Path(entry.path), st.st_size))
        s["bytes"] += st.st_size
        s["newest"] = max(s["newest"], st.st_mtime)
        return True

    for folder, pattern in ((log_dir, _SESSION_LOG), (log_dir / "turns", _SESSION_TURNS)):
        for e in _entries(folder):
            match = pattern.match(e.name)
            if match:
                add(match.group(1), e)
    for sub, written in _SESSION_FOLDERS:
        for e in _entries(log_dir / sub):
            st = _entry_stat(e) if _SESSION_NAME.match(e.name) else None
            if st is None or not stat.S_ISDIR(st.st_mode):
                continue
            found = [add(e.name, f) for f in _entries(e.path) if written.match(f.name)]
            if any(found):
                session(e.name)["folders"].append(Path(e.path))
    return sessions


def prune_plan(sessions: Dict[str, Dict[str, Any]], budget: Optional[int], protected) -> List[str]:
    """The sessions to delete, oldest first, for the rest to fit in `budget`
    bytes. A protected session is never one of them, so the rest may still not
    fit."""
    total = sum(s["bytes"] for s in sessions.values())
    if budget is None or total <= budget:
        return []
    doomed = []
    for name, s in sorted(sessions.items(), key=lambda kv: (kv[1]["newest"], kv[0])):
        if total <= budget:
            break
        if name in protected:
            continue
        doomed.append(name)
        total -= s["bytes"]
    return doomed


def prune_logs(log_dir: Path, budget: Optional[int], active=(), now: Optional[float] = None,
               skip=()) -> Dict[str, Any]:
    """Delete the oldest sessions' files in `log_dir` until the sessions fit in
    `budget` bytes, never a session named in `active` or written to within
    LOG_ACTIVE_S of `now` (time.time() when not given), nor one in `skip`.
    Returns what it did: {budget, before, after, removed: [sessions whose files
    all went], failed: [sessions with files that could not be deleted], freed,
    protected: [active or recent sessions], skipped: [sessions in `skip`],
    errors: [text], over}."""
    now = time.time() if now is None else now
    sessions = log_sessions(Path(log_dir))
    protected = {_safe_session(name) for name in active} | {
        name for name, s in sessions.items() if now - s["newest"] < LOG_ACTIVE_S}
    skipped = {name for name in skip if name in sessions} - protected
    before = sum(s["bytes"] for s in sessions.values())
    removed, failed, freed, errors = [], [], 0, []
    for name in prune_plan(sessions, budget, protected | skipped):
        whole = True
        for path, size in sessions[name]["items"]:
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            except OSError as e:
                errors.append(f"{path}: {e}")
                whole = False
                continue
            freed += size
        for folder in sessions[name]["folders"]:
            try:
                folder.rmdir()  # an empty folder only: whatever else is in it stays, and so does the folder
            except OSError:
                pass
        (removed if whole else failed).append(name)
    after = before - freed
    return {"budget": budget, "before": before, "after": after, "removed": removed, "failed": failed,
            "freed": freed, "protected": sorted(n for n in protected if n in sessions),
            "skipped": sorted(skipped), "errors": errors,
            "over": budget is not None and after > budget}


_prune_lock = threading.Lock()   # held for the whole look, by the thread doing it
_prune_clock = time.monotonic
_last_prune: Optional[float] = None
_prune_over_said = False  # the "over budget, and all of it kept" line is said once
_prune_failed: Dict[str, float] = {}  # session: when its files could not all be deleted (_prune_clock)


def _prune_in_thread(work) -> None:
    threading.Thread(target=work, name="log-budget", daemon=True).start()


_prune_start = _prune_in_thread  # the checks run the look in the request instead


def _keep_logs_in_budget(session: str) -> bool:
    """Called by every route that writes into the log folder, before it writes,
    with the session it writes for. At most once every LOG_PRUNE_EVERY_S, starts
    a look at the budget (_prune_now) on a thread of its own, and returns at
    once: the write never waits for it, and never fails because of it. Returns
    whether it started one."""
    global _last_prune
    budget, log_dir = LOG_BUDGET.bytes, LOG_DIR
    if budget is None:
        return False
    if not _prune_lock.acquire(blocking=False):
        return False  # a look is under way
    started = False
    try:
        now = _prune_clock()
        if _last_prune is None or now - _last_prune >= LOG_PRUNE_EVERY_S:
            _last_prune = now
            _prune_start(lambda: _prune_now(log_dir, budget, session, now))
            started = True
    except Exception as e:
        _announce(f"Logs: could not keep the log folder within its budget ({e}).")
    finally:
        if not started:
            _prune_lock.release()
    return started


def _prune_now(log_dir: Path, budget: int, session: str, now: float) -> None:
    """One look at the budget, and what the backend window says about it. Runs
    holding _prune_lock, and lets go of it when done."""
    global _prune_over_said
    try:
        for name, when in list(_prune_failed.items()):
            if now - when >= LOG_RETRY_S:
                del _prune_failed[name]
        result = prune_logs(log_dir, budget, active=[session], skip=list(_prune_failed))
        for name in result["removed"]:
            _prune_failed.pop(name, None)
        for name in result["failed"]:
            _prune_failed[name] = now

        def names(sessions):
            return ", ".join(sessions[:3]) + (f" and {len(sessions) - 3} more" if len(sessions) > 3 else "")

        budget_mb = f"{budget / MB:g} MB"
        if result["removed"]:
            _announce(f"Logs: deleted {len(result['removed'])} old session(s) ({result['freed'] / MB:.1f} MB: "
                      f"{names(result['removed'])}) to keep the log folder within {budget_mb}.")
        if result["failed"]:
            _announce(f"Logs: could not delete every file of {len(result['failed'])} old session(s) "
                      f"({names(result['failed'])}), first {result['errors'][0]}. They are left alone for "
                      f"{LOG_RETRY_S // 60} minutes, then tried again.")
        if result["over"] and not _prune_over_said:
            kept = []
            if result["protected"]:
                kept.append(f"{len(result['protected'])} session(s) written to in the last {LOG_ACTIVE_S // 60} minutes")
            held = result["failed"] + result["skipped"]
            if held:
                kept.append(f"{len(held)} session(s) with files that could not be deleted")
            _announce(f"Logs: {result['after'] / MB:.1f} MB of sessions are left, over the {budget_mb} budget, "
                      f"and are kept: {', and '.join(kept) or 'nothing more could be deleted'}.")
        _prune_over_said = result["over"]
    except Exception as e:
        _announce(f"Logs: could not keep the log folder within its budget ({e}).")
    finally:
        _prune_lock.release()


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


class MemoryUnreadable(Exception):
    """game-agent-memory.json exists but does not hold every game's memory, in
    words for the operator."""


# Every write reads the whole file, changes one game and writes the whole file
# back, so a write holds this from its read to its save: two at once would lose
# one's change, and replace_file uses one temporary name per process.
_memory_lock = threading.Lock()


def _load_for_update() -> Dict[str, Any]:
    """Every game's memory, to change and save: {} when there is no file yet,
    MemoryUnreadable when there is one that cannot be read. Saving {} plus one
    game over a file that did not parse (cut short by a save the backend window
    was closed during, say) would throw away every other game's memory, tuned
    weights and the operator's answers included."""
    try:
        # utf-8-sig: a file saved again from Notepad may start with a BOM.
        text = MEMORY_FILE.read_text(encoding="utf-8-sig")
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError) as e:
        raise MemoryUnreadable(f"{MEMORY_FILE.name} cannot be read ({e})") from None
    try:
        data = json.loads(text)
    except ValueError as e:
        raise MemoryUnreadable(f"{MEMORY_FILE.name} is not valid JSON ({e})") from None
    if not isinstance(data, dict):
        raise MemoryUnreadable(f"{MEMORY_FILE.name} does not hold a JSON object")
    return _fold_legacy_outcomes(data)


def _load_all() -> Dict[str, Any]:
    """Every game's memory, to read: {} when there is none, or none readable."""
    try:
        return _load_for_update()
    except MemoryUnreadable:
        return {}


def _memory_unreadable(e: MemoryUnreadable) -> JSONResponse:
    # Not overwritten: the operator decides what to keep from it.
    return JSONResponse({"ok": False, "error": f"{e}: nothing was saved, and the file was left as it is. "
                                               "Fix it or move it aside, then try again"}, status_code=409)


def _save_all(data: Dict[str, Any]) -> None:
    """Write every game's memory, in one step (replace_file): a save cut short
    leaves the old file, never half of one. Called holding _memory_lock."""
    _fold_legacy_outcomes(data)
    replace_file(MEMORY_FILE, json.dumps(data, indent=2, ensure_ascii=False))


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


def _new_entry(game_key: str, game_desc: str) -> Dict[str, Any]:
    """A game's memory entry before its first session."""
    return {
        "gameKey": game_key,
        "gameDesc": game_desc,
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
    }


@app.post("/memory/{game_key}")
def memory_patch(game_key: str, patch: MemoryPatch):
    with _memory_lock:
        try:
            data = _load_for_update()
        except MemoryUnreadable as e:
            return _memory_unreadable(e)
        entry = data[game_key] if game_key in data else _new_entry(game_key, patch.gameDesc)
        _apply_patch(entry, patch)
        data[game_key] = entry
        _save_all(data)
    return {"ok": True, "entry": entry}


def _apply_patch(entry: Dict[str, Any], patch: MemoryPatch) -> None:
    """One session's MemoryPatch, added to a game's memory entry in place."""
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


# ── Where a game may be played ─────────────────────────────────────────────────
# Before a game's first run the page asks the operator, once, whether it may be
# played unattended at all: single-player; not signed in, or in a browser
# profile of its own; results not posted to public rankings, or the site's
# terms allow bots; and the date the terms were checked (src/agent/sitePolicy.js
# says why, and SETUP.md "Which games the agent may play" is the policy). The
# answer is kept in the game's memory entry as "acknowledgement", so it is asked
# once per game and dated, and Clear Memory forgets it with the rest.
#
# Only this route writes it. The model's update_memory goes through MemoryPatch,
# which has no such field (pydantic drops fields it does not know), so what a
# screen talks a model into cannot acknowledge anything.

# The same numbers as ACK_TERMS_MAX, ACK_EARLIEST and ACK_NAME_MAX in
# src/agent/sitePolicy.js (tools/check-site-policy.mjs compares them). The page
# cuts a longer game name short, since here it only labels a new entry.
ACK_TERMS_MAX = 300
ACK_EARLIEST = "2000-01-01"
ACK_NAME_MAX = 200


class Acknowledgement(BaseModel):
    gameDesc: str = Field(min_length=1, max_length=ACK_NAME_MAX)
    singlePlayer: Literal[True]
    account: Literal["not-signed-in", "dedicated-profile"]
    rankings: Literal["not-ranked", "terms-allow-bots"]
    termsCheckedOn: datetime.date
    terms: Optional[str] = Field(None, max_length=ACK_TERMS_MAX)
    site: Optional[str] = Field(None, max_length=253)

    @field_validator("termsCheckedOn")
    @classmethod
    def _a_real_day(cls, value: datetime.date) -> datetime.date:
        # A day ahead is allowed for a page whose clock sits in a later time zone.
        if value > datetime.date.today() + datetime.timedelta(days=1):
            raise ValueError("is after today")
        if value < datetime.date.fromisoformat(ACK_EARLIEST):
            raise ValueError(f"is before {ACK_EARLIEST}")
        return value


@app.post("/memory/{game_key}/acknowledgement")
def memory_acknowledge(game_key: str, ack: Acknowledgement):
    """Keep the operator's answers for this game. Not a session: nothing else in
    the entry changes. A memory file that cannot be read is refused (409), not
    replaced: it would look to the page as if no game had been answered for,
    and the first answers saved would overwrite every game's memory."""
    with _memory_lock:
        try:
            data = _load_for_update()
        except MemoryUnreadable as e:
            return _memory_unreadable(e)
        entry = data[game_key] if game_key in data else _new_entry(game_key, ack.gameDesc)
        record = ack.model_dump(mode="json", exclude={"gameDesc"})
        record["acknowledgedAt"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
        entry["acknowledgement"] = record
        data[game_key] = entry
        _save_all(data)
    return {"ok": True, "acknowledgement": record}


# ── Run records: which code played what, and how it went ─────────────────────
# The session log tells one run's story in words. Comparing runs (this commit
# against the last, one model against another, a game with a plugin against one
# without) needs the same facts in the same shape every time, and memory keeps
# only a best score and the last few results per game. So the page also sends
# three kinds of record, written here as JSON:
#   logs/runs/<session>/run.json   what the run was: both commits, provider,
#                                  model and settings    (POST /episode/run)
#   logs/episodes.jsonl            one line per game played, every run, in one
#                                  file                  (POST /episode/game)
#   logs/turns/<session>.jsonl     one line per turn: where its time went, the
#                                  tokens, what it did   (POST /episode/turns)
# The backend adds its own commit to run.json and to each game line, so a record
# says which backend wrote it even when the page is out of date. What the page
# puts in them is in src/agent/episodes.js and src/agent/turnClock.js, and
# tools/episodes.mjs sums up episodes.jsonl.

# What one request may write. Far above what the page sends (it batches turns
# to fit, src/agent/logQueue.js holds the same numbers and tools/check-agent.mjs
# compares them): these stop a runaway or hostile request filling the disk.
EPISODE_RECORD_MAX_BYTES = 64 * 1024
TURN_RECORDS_MAX = 1000
TURN_RECORDS_MAX_BYTES = 1024 * 1024
EPISODES_FILE_NAME = "episodes.jsonl"
# Bumped when a record changes shape, so tools/episodes.mjs can tell.
RECORD_FORMAT = 1

# Routes run in a thread pool, so two appends to one file could interleave.
_records_lock = threading.Lock()

ScoreSource = Literal["measured", "model", "none"]


def _run_file(session: str) -> Path:
    return LOG_DIR / "runs" / _safe_session(session) / "run.json"


def _turns_file(session: str) -> Path:
    return LOG_DIR / "turns" / f"{_safe_session(session)}.jsonl"


def _episodes_file() -> Path:
    return LOG_DIR / EPISODES_FILE_NAME


def _now() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _json_line(record: Dict[str, Any]) -> str:
    """One record as one line of strict JSON. NaN and Infinity are refused
    (ValueError): Python would write them, and no JSON reader would read them."""
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _not_json(e: Exception) -> JSONResponse:
    message = f"not written: the record is not plain JSON ({e})"
    # detail, as FastAPI's own refusals have: the page does not send it again.
    return JSONResponse({"ok": False, "error": message, "detail": message}, status_code=422)


def _in_log_dir(path: str) -> str:
    """A file the backend wrote, relative to the log folder when it is in it, so
    a record still points at it when the folder is copied elsewhere."""
    try:
        return Path(path).resolve().relative_to(LOG_DIR.resolve()).as_posix()
    except (OSError, ValueError):
        return path


def _append_lines(path: Path, lines: List[str]) -> None:
    with _records_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8", errors="replace") as fh:
            for line in lines:
                fh.write(line + "\n")


class RunRecordBody(BaseModel):
    session: str
    run: Dict[str, Any]


class GameRecord(BaseModel):
    # The fields every game line has, typed, so the ledger cannot fill with
    # outcomes that are not outcomes. Anything else the page adds (the game's
    # name, provider, model, its own commit) is kept as it is.
    model_config = ConfigDict(extra="allow")

    game: int = Field(ge=1)
    outcome: Outcome
    # A game ■ Stop ended before anything else did: "ended", but not by itself.
    stopped: bool = False
    turns: int = Field(ge=0)
    durationMs: int = Field(ge=0)
    score: Union[int, float, None] = None
    scoreSource: ScoreSource
    stuckReason: Optional[str] = None
    snapshots: List[str] = Field(default_factory=list, max_length=200)
    memoryHash: Optional[str] = None


class GameRecordBody(BaseModel):
    session: str
    game: GameRecord


class TurnRecordsBody(BaseModel):
    session: str
    records: List[Dict[str, Any]]


@app.post("/episode/run")
def episode_run(b: RunRecordBody):
    """Write run.json for this session, replacing any earlier one."""
    record = {"format": RECORD_FORMAT, **b.run, "session": b.session,
              "backend": {**VERSION, "startedAt": STARTED_AT}, "recordedAt": _now()}
    try:
        text = json.dumps(record, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    except (TypeError, ValueError) as e:
        return _not_json(e)
    # Half an emoji (a lone surrogate) is valid in a JSON string but cannot be
    # written as UTF-8: it becomes "?", as in the log and the other records.
    # Left in, the write failed with a bare HTTP 500 that the page retried every
    # 2 s for good, holding back every record queued after it.
    text = text.encode("utf-8", "replace").decode("utf-8")
    size = len(text.encode("utf-8"))
    if size > EPISODE_RECORD_MAX_BYTES:
        return _too_large(f"a run record of {size} bytes", f"{EPISODE_RECORD_MAX_BYTES} bytes")
    _keep_logs_in_budget(b.session)
    try:
        path = _run_file(b.session)
        with _records_lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            replace_file(path, text)
        return {"ok": True, "path": str(path)}
    except OSError as e:
        return {"ok": False, "error": str(e)}


@app.post("/episode/game")
def episode_game(b: GameRecordBody):
    """Add one game's line to episodes.jsonl."""
    game = b.game.model_dump()
    game["snapshots"] = [_in_log_dir(p) for p in game["snapshots"]]
    record = {"format": RECORD_FORMAT, "session": b.session, **game,
              "backendCommit": VERSION["commit"], "backendDirty": VERSION["dirty"], "recordedAt": _now()}
    try:
        line = _json_line(record)
    except (TypeError, ValueError) as e:
        return _not_json(e)
    size = len(line.encode("utf-8", "replace"))
    if size > EPISODE_RECORD_MAX_BYTES:
        return _too_large(f"a game record of {size} bytes", f"{EPISODE_RECORD_MAX_BYTES} bytes")
    _keep_logs_in_budget(b.session)
    try:
        path = _episodes_file()
        _append_lines(path, [line])
        return {"ok": True, "path": str(path)}
    except OSError as e:
        return {"ok": False, "error": str(e)}


@app.post("/episode/turns")
def episode_turns(b: TurnRecordsBody):
    """Add turn records to this session's turns file, one line each."""
    if len(b.records) > TURN_RECORDS_MAX:
        return _too_large(f"{len(b.records)} turn records", f"{TURN_RECORDS_MAX} records")
    try:
        lines = [_json_line({"format": RECORD_FORMAT, **record}) for record in b.records]
    except (TypeError, ValueError) as e:
        return _not_json(e)
    size = sum(len(line.encode("utf-8", "replace")) + 1 for line in lines)
    if size > TURN_RECORDS_MAX_BYTES:
        return _too_large(f"{size} bytes of turn records", f"{TURN_RECORDS_MAX_BYTES} bytes")
    _keep_logs_in_budget(b.session)
    try:
        path = _turns_file(b.session)
        _append_lines(path, lines)
        return {"ok": True, "path": str(path), "written": len(lines)}
    except OSError as e:
        return {"ok": False, "error": str(e)}


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
    with _memory_lock:
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


@input_route("/gamepad/button")
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

        held, halted = _hold_down(press, release, [key], hold, kind="pad")
        return {"ok": True, "held": held, "halted": halted, "limit": limit}
    except Exception as e:
        return {"ok": False, "error": str(e), "limit": limit}


def _stay_or_hold(set_value, value, rest, duration: float) -> dict:
    """Move a stick or trigger to `value` with `set_value`. With a duration of 0
    (or less) it stays there until the next call; with a positive one it is held
    for up to GAMEPAD_HOLD_MAX_S (see _hold) and then set back to `rest`, however
    the hold ends. While input is halted it is not moved at all.

    A stick or trigger is not in _held, so a halt that came between the check
    and set_value (its gamepad reset done first) would leave it where this put
    it for the whole halt: the flag is asked again once it is there."""
    applied = _within(duration, 0.0, GAMEPAD_HOLD_MAX_S)
    limit = _limit(duration, applied, 0.0, GAMEPAD_HOLD_MAX_S, "s")
    if _input_halted():
        return {"held": 0.0, "halted": True, "limit": limit}
    set_value(value)
    if _input_halted():
        set_value(rest)
        return {"held": 0.0, "halted": True, "limit": limit}
    if applied <= 0:
        return {"held": 0.0, "halted": False, "limit": limit}
    try:
        held, halted = _hold(applied)
    finally:
        set_value(rest)
    return {"held": held, "halted": halted, "limit": limit}


@input_route("/gamepad/stick")
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


@input_route("/gamepad/trigger")
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


# Not an input route: it only chooses which part of the screen /capture/frame
# grabs, and moves no window and no focus.
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


@input_route("/game/attach")
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


@input_route("/game/speed")
def game_speed(b: SpeedBody):
    if not SPEEDHACK_AVAILABLE or _speed_client is None:
        return {"ok": False, "error": "not attached to a game"}
    try:
        # A halt sets the game back to normal speed. One that came while this
        # request was past HaltGate could have done so just before this call,
        # and pause-to-think's speed 0 would then freeze the game for the whole
        # halt (the page's own speed 1 is refused while halted): the flag is
        # asked again afterwards, and a halted game is set back to 1.
        if _input_halted():
            return _halted_reply()
        _speed_client.set_speed(max(0.0, b.speed))
        if _input_halted():
            _speed_client.set_speed(1.0)
            return _halted_reply()
        return {"ok": True, "speed": b.speed}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# Not an input route: it lets the game run at normal speed, as a halt does, so it
# is allowed while input is halted.
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
    print(f"Commit   : {_version_note(VERSION)}")
    print("           The page says at Start if it runs another commit: then restart start.bat.")
    print(f"Platform : {platform.system()}")
    print(f"Screen   : {SCREEN_W} x {SCREEN_H} px")
    print(f"Logs     : {LOG_DIR}" + (f" (from {LOG_DIR_ENV})" if (os.environ.get(LOG_DIR_ENV) or "").strip() else ""))
    print(f"           {budget_note(LOG_BUDGET)}")
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
    hotkeys = start_halt_hotkeys()
    print()
    if hotkeys["registered"]:
        print(f"Kill switch: {' or '.join(hotkeys['registered'])} halts all input.")
        print("             Resume on the agent page lifts it. A game in front can block the chord:")
        print("             then Alt+Tab to the agent page and click Stop. (A screen corner is NOT a kill switch.)")
    else:
        print("Kill switch: NO HOTKEY - use Stop on the agent page, which halts input too.")
    for problem in hotkeys["problems"]:
        print(f"             {problem}")
    print("Press Ctrl+C to quit.")
    print()
    # On the socket claimed at the top of this file, before the token was written.
    uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[_listener])
