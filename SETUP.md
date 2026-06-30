# Game Agent — Windows Setup & Test Guide

This guide gets the agent running on Windows 11 and walks through validating every
feature **in a recommended order**, starting from the safest (your existing 2048
baseline) and building up to gamepad, native capture, and pause-to-think.

> All features are **optional and off/neutral by default**, so you can validate one
> at a time. If a capability's driver isn't installed, the backend degrades
> gracefully and the UI shows a hint.

---

## 1. One-time prerequisites

| Need | Why | Install |
|------|-----|---------|
| **Python 3.10+** | Backend (`agent_server.py`) | python.org — check "Add to PATH" |
| **Node.js 18+** | Frontend (Vite/React) | nodejs.org (LTS) |
| **Gemini API key** | Free LLM provider | aistudio.google.com → API key |
| **ViGEmBus driver** | Required for **gamepad** output | github.com/ViGEm/ViGEmBus/releases → run the installer → reboot |

`start.bat` installs the Python/Node packages automatically, including the optional
ones (`vgamepad`, `dxcam`, `xspeedhack`, `psutil`, `pygetwindow`). If any optional
pip package fails, the agent still runs — that capability is just disabled.

> **Gamepad needs the ViGEmBus driver in addition to the `vgamepad` pip package.**
> Without it, `vgamepad` import fails and gamepad buttons return an error.

---

## 2. Get the latest code

```cmd
cd "C:\Users\Luis Alberto\game-agent"
git pull origin claude/review-game-agent-DGtPg
```

(First time only:)
```cmd
git clone https://github.com/luisalberto0023/Claude-Code-v1 game-agent
cd game-agent
git checkout claude/review-game-agent-DGtPg
```

Make sure `.env` exists with your real key:
```cmd
copy .env.example .env
notepad .env          REM replace the placeholder with your Gemini key
```

---

## 3. Launch

Double-click **`start.bat`**. It will:
- create the Python venv + install packages,
- start the backend (port 8765) in its own window,
- open the browser to `localhost:5173`,
- start the Vite dev server.

In the **backend window**, check the `Capabilities:` banner — it tells you exactly
what loaded:
```
gamepad  (vgamepad)  : ready / missing ...
capture  (dxcam)     : ready / missing ...
windows  (pygetwindow): ready / missing ...
speedhack(xspeedhack): ready / missing ...
```

> **Emergency stop at any time:** slam the mouse into the **top-left screen corner**
> (pyautogui FAILSAFE), or click **■ Stop** in the UI.

---

## 4. Validation order (do these in sequence)

### ✅ Test 0 — Baseline (regression check)
Confirm nothing broke. This should behave exactly like before.
- Open `https://play2048.co` in a tab.
- UI: Provider **Gemini 2.5 Flash**, Control scheme **🌐 Browser · KB/Mouse**,
  Timing **Puzzle**.
- ADVANCED: check **Skip research phase**, set **Token budget cap** = `50000`.
- Click **Share Screen** → pick the 2048 tab → **▶ Start**.
- **Pass:** agent studies, sets goals, plays with arrow keys, score rises,
  memory file appears (`game-agent-memory.json`).

### ✅ Test 1 — Click-grid accuracy (#4)
- Keep Browser · KB/Mouse. ADVANCED → ensure **Click-grid overlay** is ON.
- Use any click-based browser game (e.g. Minesweeper, solitaire, a point-and-click).
- **Pass:** log shows `→ click_grid(...)`, and clicks land on the intended cell.
  If clicks are off, that's the DPI/scale path to debug — note the reported
  `image x,y` vs where it landed.

### ✅ Test 2 — B2 slow loop (token saver, #3)
- ADVANCED → set **Vision every N turns** = `3`.
- Play 2048 again with a token cap.
- **Pass:** log shows `Tactical turn N (text-only)` between vision turns, and the
  In/Out token counters climb noticeably slower than Test 0.

### ✅ Test 3 — HUD crop
- ADVANCED → check **Crop to game area (HUD mask)**.
- Set margins (e.g. `top 8`, `left 2`, `right 2`, `bottom 2` %), click **Preview**.
- **Pass:** the preview shows the game tightly framed (browser chrome trimmed),
  with the grid drawn over the cropped area. Then run and confirm clicks still land.

### ✅ Test 4 — Virtual gamepad is detected
**Do this before any gamepad game** — it isolates driver/plumbing from game logic.
- Open a gamepad tester: **https://hardwaretester.com/gamepad**
- UI: Control scheme **🎮 Native · Gamepad**. (Capability hint should NOT warn if
  ViGEmBus + vgamepad are installed.)
- Share Screen → pick the tester tab → **▶ Start**, and/or watch the tester while
  the agent issues `gamepad_button` / `gamepad_stick` calls.
- **Pass:** the on-screen controller in the tester lights up buttons and moves
  sticks when the agent acts. If nothing registers → ViGEmBus not installed or
  needs a reboot.

### ✅ Test 5 — Gamepad in a real browser game
- Suggested game: **HexGL** — `https://hexgl.bkcore.com/play/` (free, open-source
  WebGL racer with gamepad support). Racing is exactly what gamepad control suits:
  `gamepad_stick left` to steer, `gamepad_trigger right` to accelerate,
  `gamepad_button a` for boost.
- Control scheme **🎮 Native · Gamepad**, Timing **Arcade**.
- **Pass:** the car responds to the agent's stick/trigger actions.
- (Alternative: any browser game with an in-page "gamepad supported" note. Many
  HTML5 games only read keyboard — the tester in Test 4 tells you if a page sees
  the pad.)

### ✅ Test 6 — Native DirectX capture (dxcam)
- Control scheme = any **Native ·** scheme. ADVANCED-area **NATIVE GAME OPTIONS**
  panel → check **Capture via DirectX (dxcam)** → **↻ List windows** → pick the
  game window.
- **Pass:** "● region set" appears; **▶ Start** runs without you sharing a screen,
  and the agent sees the game. (Use the crop **Preview** to eyeball the captured
  region.)

### ✅ Test 7 — Pause-to-think (single-player native only)
> ⚠️ **Never** use this on online/multiplayer or anti-cheat games — it uses DLL
> injection to slow the game clock and will get you banned. Single-player only.
- Open a single-player native game (e.g. a freeware platformer / emulator).
- NATIVE GAME OPTIONS → check **Pause game while thinking** → type the process
  name (e.g. `game.exe`, exactly as in Task Manager → Details) → **Attach**.
- **Pass:** "● attached" shows; during play the game visibly freezes while the
  agent thinks and resumes when it acts. The log notes pause-to-think is ON.

---

## 5. What to watch in the log

| Log line | Confirms |
|----------|----------|
| `[Screen unchanged — image omitted ...]` | A1 image-skip |
| `Tactical turn N (text-only)` | B2 slow loop |
| `→ click_grid(...)` | Discrete-grid clicking |
| `→ gamepad_button(...)` / `gamepad_stick` | Gamepad output |
| `Control scheme: ... · pause-to-think ON` | Scheme + pause active |
| `Attached to <proc> (pid ...)` | Speed hack attached |
| Backend banner `... : ready` | Capability/driver present |

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Gamepad buttons error / tester dead | ViGEmBus driver not installed or no reboot |
| "vgamepad not installed" | optional pip install failed — `pip install vgamepad` in the venv |
| Native capture returns no frame | `pip install dxcam`; some GPUs need the game in *windowed/borderless* mode |
| Window list empty | `pip install pygetwindow`; run as the same user as the game |
| Pause-to-think "not attached" | wrong process name (use Task Manager → Details exact `.exe`), or `xspeedhack` missing |
| Clicks land off-target | check the HUD `Scale` value; try DirectX capture or a crop to simplify the mapping |
| 429 rate-limit pauses | Gemini free tier — keep **Skip research** on, lower **Vision every N turns** later |
| Backend window closed | re-run `start.bat`; the watchdog auto-pauses the agent if the backend drops |

---

## 7. Safety recap
- **FAILSAFE:** mouse to top-left corner kills all input instantly.
- **Pause-to-think:** offline single-player games only.
- The agent controls your real mouse/keyboard/gamepad — keep the game in focus and
  don't leave it unattended on anything that can take destructive actions.
