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
import re
import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

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
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.0

SCREEN_W, SCREEN_H = pyautogui.size()

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

app = FastAPI(title="Game Agent Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _capabilities():
    return {
        "gamepad": GAMEPAD_AVAILABLE,
        "capture": CAPTURE_AVAILABLE,
        "windows_api": WINDOWS_API,
        "speedhack": SPEEDHACK_AVAILABLE,
    }


@app.get("/health")
def health():
    return {
        "status": "ok",
        "platform": platform.system(),
        "screen_width": SCREEN_W,
        "screen_height": SCREEN_H,
        "capabilities": _capabilities(),
    }


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


@app.post("/mouse/move")
def mouse_move(b: MoveBody):
    try:
        pyautogui.moveTo(b.x, b.y, duration=b.duration)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/click")
def mouse_click(b: ClickBody):
    try:
        pyautogui.moveTo(b.x, b.y, duration=b.move_duration)
        pyautogui.click(button=b.button, clicks=b.clicks, interval=0.05)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/drag")
def mouse_drag(b: DragBody):
    try:
        pyautogui.moveTo(b.x1, b.y1, duration=0.1)
        pyautogui.dragTo(b.x2, b.y2, duration=b.duration, button=b.button)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/mouse/scroll")
def mouse_scroll(b: ScrollBody):
    try:
        pyautogui.moveTo(b.x, b.y, duration=0.05)
        pyautogui.scroll(b.amount)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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


@app.post("/keyboard/press")
def key_press(b: KeyBody):
    try:
        keys = _parse_key(b.key)
        if len(keys) > 1:
            pyautogui.hotkey(*keys)
        else:
            pyautogui.press(keys[0])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/keyboard/hold")
def key_hold(b: HoldBody):
    try:
        keys = _parse_key(b.key)
        for k in keys:
            pyautogui.keyDown(k)
        time.sleep(b.duration)
        for k in reversed(keys):
            pyautogui.keyUp(k)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/keyboard/type")
def key_type(b: TypeBody):
    try:
        if all(ord(c) < 128 for c in b.text):
            pyautogui.typewrite(b.text, interval=b.interval)
        else:
            prev = ""
            try:
                prev = pyperclip.paste()
            except Exception:
                pass
            pyperclip.copy(b.text)
            pyautogui.hotkey("ctrl", "v")
            time.sleep(0.1)
            if prev:
                try:
                    pyperclip.copy(prev)
                except Exception:
                    pass
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Screen info ────────────────────────────────────────────────────────────────

@app.get("/screen/info")
def screen_info():
    return {"width": SCREEN_W, "height": SCREEN_H, "platform": platform.system()}


# ── Memory storage ─────────────────────────────────────────────────────────────

MEMORY_FILE = Path(__file__).parent / "game-agent-memory.json"


def _load_all() -> Dict[str, Any]:
    if MEMORY_FILE.exists():
        try:
            return json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _save_all(data: Dict[str, Any]) -> None:
    MEMORY_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:64]


class MemoryPatch(BaseModel):
    gameDesc: str
    outcome: Optional[str] = None
    score: Optional[float] = None
    strategy: Optional[str] = None
    strategyReason: Optional[str] = None
    discoveries: Optional[List[str]] = None
    avoidPatterns: Optional[List[str]] = None
    durationSeconds: Optional[int] = None
    turnCount: Optional[int] = None


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
        "outcomes": {"won": 0, "lost": 0, "stuck": 0, "ended": 0},
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
    "a": "A", "b": "B", "x": "X", "y": "Y",
    "lb": "LEFT_SHOULDER", "rb": "RIGHT_SHOULDER",
    "ls": "LEFT_THUMB", "rs": "RIGHT_THUMB",
    "start": "START", "back": "BACK", "guide": "GUIDE",
    "up": "DPAD_UP", "down": "DPAD_DOWN", "left": "DPAD_LEFT", "right": "DPAD_RIGHT",
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
    try:
        gp = _get_gamepad()
        btn = _xusb(key)
        gp.press_button(button=btn)
        gp.update()
        time.sleep(max(0.02, min(b.hold, 5.0)))
        gp.release_button(button=btn)
        gp.update()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/gamepad/stick")
def gamepad_stick(b: GamepadStickBody):
    if not GAMEPAD_AVAILABLE:
        return {"ok": False, "available": False, "error": "vgamepad not installed"}
    try:
        gp = _get_gamepad()
        x = max(-1.0, min(1.0, b.x))
        y = max(-1.0, min(1.0, b.y))
        setter = gp.left_joystick_float if b.stick == "left" else gp.right_joystick_float
        setter(x_value_float=x, y_value_float=y)
        gp.update()
        if b.duration and b.duration > 0:
            time.sleep(min(b.duration, 5.0))
            setter(x_value_float=0.0, y_value_float=0.0)
            gp.update()
        return {"ok": True}
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
        setter(value_float=val)
        gp.update()
        if b.duration and b.duration > 0:
            time.sleep(min(b.duration, 5.0))
            setter(value_float=0.0)
            gp.update()
        return {"ok": True}
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
    print(f"API      : http://localhost:8765")
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
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
