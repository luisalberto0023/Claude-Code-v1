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

app = FastAPI(title="Game Agent Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "platform": platform.system(),
        "screen_width": SCREEN_W,
        "screen_height": SCREEN_H,
    }


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


# ── Main ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("Game Agent Backend Server")
    print("─" * 40)
    print(f"Platform : {platform.system()}")
    print(f"Screen   : {SCREEN_W} x {SCREEN_H} px")
    print(f"API      : http://localhost:8765")
    print(f"DPI-aware: {'yes' if platform.system() == 'Windows' else 'n/a'}")
    print()
    print("Move mouse to TOP-LEFT corner to emergency-stop.")
    print("Press Ctrl+C to quit.")
    print()
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")
