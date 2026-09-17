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

Optional, after a pull: confirm the new code works on this machine before
launching anything.
```cmd
npm run check
```
It renders the UI once in node (a blank-page bug fails here), checks that the page
and the backend use the same outcome names, checks that a failed model request
pauses the run instead of ending the game (against a stand-in, so no provider is
called and no key is needed), runs the plugin and
Minesweeper checks, checks that the page sends the backend's token (see Launch),
and starts the backend on a spare port with every mouse,
keyboard, gamepad and capture call replaced by a recorder, so it never moves
your mouse or presses a key and never uses port 8765. There it also checks that
the backend refuses requests without the token or from other sites. The backend step needs
`.venv`, so run `start.bat` once first on a fresh clone.

The run is good only if its last line is `ok    nothing got past the named stubs`.
Anything else means the pulled code (or this machine's setup) is broken: a `FAIL`
or `MISSING` line, an error message, or output that stops before that line (each
step only runs if the one before it passed). Report it before starting a run.

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

### Only the agent page can use the backend
The backend moves your real mouse and keyboard, and any web page open in your
browser can send requests to it. So it only takes requests that carry the secret
token it makes each time it starts, from the agent page at
`http://localhost:5173` (or `http://127.0.0.1:5173`). A site you visit while the
agent runs cannot click, type or read your screen through it. There is nothing to
set up: the backend writes the token to `.agent-token` in the project folder
(git ignores it), and the Vite dev server puts it into the page each time the page
loads. The backend window shows it as
`Token    : new for this start, written to .agent-token`.

- **After restarting the backend (or `start.bat`), reload any agent tab that was
  already open (F5).** Until then that tab shows a red box, `⛔ The backend refused
  this page's token ...`, with a **Reload page** button; the `Backend online` pill
  turns red, and a running session pauses. The tab `start.bat` opens is fresh and
  already has the new token.
- Open the agent only at `http://localhost:5173`. A page from another address, or
  from `npm run build` / `vite preview`, has no token and is refused.
- Don't copy or share `.agent-token`: until the backend stops, it lets a page
  drive this PC's mouse and keyboard.
- Optional: to keep one token across restarts (so open tabs keep working), run
  `set AGENT_TOKEN=<32 to 256 letters, digits, - or _>` in a Command Prompt and
  start `start.bat` from that same prompt. The banner then says `from AGENT_TOKEN`.

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
> The same goes for everything else the agent does: see **Anti-cheat** in the
> Safety recap.
- Open a single-player native game (e.g. a freeware platformer / emulator).
- NATIVE GAME OPTIONS → check **Pause game while thinking** → type the process
  name (e.g. `game.exe`, exactly as in Task Manager → Details) → **Attach**.
- **Pass:** "● attached" shows; during play the game visibly freezes while the
  agent thinks and resumes when it acts. The log notes pause-to-think is ON.

### ✅ Test 8 — The model drops out mid-session
A request that fails is not the end of the game. The run pauses, leaves the board
alone, and carries on by itself once the model answers again.
- Provider **Ollama**, a game **without** a built-in solver (turn **Use built-in
  solver** off for 2048), **Games per session** = `2`.
- Start, let it play a few turns, then stop Ollama (quit it from the tray, or
  `taskkill /im ollama.exe /f` on the Ollama host).
- **Pass while it is down:** after a few `Error: ... — retrying in 2s/4s/8s...` lines
  the log shows `Model request failed after ...` and then
  `⏸ Paused: model unreachable. The board is left as it is. Checking again in 15s ...`.
  The HUD **Status** reads `paused: model unreachable` and **Model** counts down
  to the next check (15 s, 30 s, 60 s, then every 120 s). The board does not
  change, no `Game 1 finished` line appears, and nothing clicks New Game.
- Start Ollama again. **Pass:** at the next check the log shows
  `▶ The model is answering again — resuming play.` and play continues on the
  same board.
- Optional, 15 minutes: leave Ollama stopped. **Pass:** `Session given up: the model
  has not answered for 15 minutes ...`, then `Session complete — outcome: aborted`.
  The board is still as it was, and `game-agent-memory.json` counts the session
  under `outcomes.aborted`, not `ended`.
- Optional, a wrong key: pick a cloud provider and paste a wrong API key.
  **Pass:** research (unless skipped) and the first study turn each log one
  warning, the study is skipped, and the first turn of play ends the session at
  once with `Session given up:` and the provider's own message (e.g.
  `... did not accept the API key (HTTP 401)`), with no retries in between.
- **■ Stop** during any of this ends the request or the wait straight away.
  **Pass:** stopped while `paused: model unreachable` shows, the log reads
  `Session given up: stopped while waiting for the model to answer ...` and
  `Session complete — outcome: aborted`; no `Game 1 finished` line, and no
  post-session analysis. Stopped during the `retrying in 2s/4s/8s` lines, or on
  the first turn after the model answered a check, it is the same, except the
  log reads `Session given up: stopped while the model was not answering ...`.
  (Stopped while the model is answering, a session ends as before, and the log
  says `Running post-session analysis... (press ■ Stop again to skip it)`.)
- With **pause-to-think** on (Test 7's setup), the game stays frozen while the run
  waits for the model, and the `⏸ Paused` line says so. **Pass:** it runs again
  once play resumes, or when the session ends.

### ✅ Test 9 — Only the agent page can drive the backend
- Start with `start.bat`. **Pass:** the backend window shows
  `Token    : new for this start, written to .agent-token`, and the agent page logs
  `Backend online — Windows <width>×<height>` with the screen size next to
  **Share Screen**.
- Run Test 0 for a few moves. **Pass:** it plays exactly as before (every key and
  click goes through the page's `/api` proxy with the token).
- Open `https://example.com` in another tab, press F12, and in its **Console** run
  these two lines, one at a time, with the **Network** tab open:
  ```js
  fetch("http://127.0.0.1:8765/mouse/move", {method: "POST", mode: "no-cors", body: JSON.stringify({x: 400, y: 400, duration: 0})})
  fetch("http://localhost:5173/api/mouse/move", {method: "POST", mode: "no-cors", body: JSON.stringify({x: 400, y: 400, duration: 0})})
  ```
  If the browser asks whether example.com may access devices on your local
  network, click **Allow** for this test, so the requests really reach the backend
  and it is the backend's refusal being tested; remove that permission afterwards
  (the site-settings icon left of the address bar).
  **Pass:** in the **Network** tab both requests show status `403`: the first is
  the backend refusing another site, the second the same refusal through Vite's
  proxy. Judge by the status, not the mouse pointer: the pointer would stay put
  even without the check, because another site can send this body only as plain
  text and the backend reads only JSON. A `422` or `200` means the backend read
  the request: stop and report it (report any status other than `403`). A
  request shown as failed or blocked never left the browser: allow local network
  access as above and run it again.
- Open `http://localhost:5173/.agent-token` in a new tab. **Pass:** `403 Restricted`,
  not the token: the page is the only place Vite hands the token out.
- Close only the **Game Agent Backend** window, then start the backend again from a
  new Command Prompt in the project folder: `.venv\Scripts\python agent_server.py`.
  **Pass:** within about 20 seconds the agent tab shows the red
  `⛔ The backend refused this page's token ...` box and the `Backend online` pill
  turns red. Click **Reload page**. **Pass:** the box is gone and the log shows
  `Backend online — ...` again.
- Double-click `start.bat` a second time while everything is running. **Pass:** its
  new backend window says `Could not start on port 8765 ... Is the backend already
  running in another window?`, and the agent tab you already had keeps working (no
  red box, moves still happen). Close the second `start.bat` window and its
  failed backend window with their **X** buttons, not Ctrl+C: Ctrl+C runs
  `start.bat`'s cleanup, which closes backend windows.

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
| `Backend online — Windows 1920×1080` | The page reached the backend with its token. The screen size now comes from `/screen/info`; `/health` answers anyone and says only `ok` |
| `⛔ The backend refused this page's token. ...` (and a red box with **Reload page**) | The backend was restarted after this tab loaded, so the tab's token is old. Reload the tab. A running session pauses; a session using the Ollama relay is given up (`Session given up: the backend refused to relay the request to Ollama ...`) |
| `📷 The frame was too large to save whole; saving it at 1/2 size.` | A snapshot frame was over the backend's 8 MB limit as a PNG (a large, busy screen) and was saved smaller rather than not at all |
| `Game N finished — won` / `Session complete — outcome: won` | A win. Outcomes are always one of `won`, `lost`, `stuck`, `ended`, `aborted`; `win` no longer appears. The backend reads an old `win` count in the memory file as `won` straight away, and the file itself is rewritten without `win` the next time a session saves to it |
| `● Minesweeper ready` (ADVANCED, next to "Use built-in solver") | The solver that matches the game name, by its own name (it said `2048 ready` for every game before) |
| `Reported a win the solver never measured (highest tile ...) — recording as ended.` | While the 2048 solver was playing, the model claimed a win but no 2048 tile was built; the game is recorded as `ended`, not `won`. This check existed before but could never fire. It applies only to solvers that track tiles (2048), not to Minesweeper |
| `Reported outcome "..." is not one of won, lost, stuck, ended — recording as ended.` | The model (usually in JSON-action mode) reported an outcome name that does not exist. The prompt and, in JSON-action mode, the tool list name the four it may use, so this should be rare |
| `Memory not saved — ... game-agent-memory.json was not updated.` | The backend refused or never got the save. See Troubleshooting |
| `Error: ... — retrying in 2s...` (then 4s, 8s) | A model request failed in a way that may clear up (no answer, a server error, an Ollama `HTTP 400` from a request cut off in transit). A rate limit (`Rate limited — waiting 15s...`) waits longer. A wrong key or model is never retried |
| `Model request failed after Ns: ...` | The retries did not help. What follows depends on the cause: a pause (below) or, for a key or model the provider refuses, `Session given up` |
| `⏸ Paused: model unreachable. The board is left as it is. Checking again in 15s ...` | The run is waiting for the model, not playing. HUD **Status** `paused: model unreachable`. No outcome is recorded and New Game is not clicked. It checks at 15 s, 30 s, 60 s, then every 120 s, and gives each check at most 2 minutes. With pause-to-think, the game stays frozen until play resumes |
| `▶ The model is answering again — resuming play.` | The wait is over; the same game continues |
| `Session given up: ... ` then `Session complete — outcome: aborted` | The model did not answer for 15 minutes, refused the request outright (the provider's message is quoted), or **■ Stop** was pressed while the model was not answering (during the wait, a retry, or the first turn after it answered again). The board was left alone and memory counts the session as `aborted`, with no post-session analysis |
| `Study turn error: ... — skipping the rest of the study.` | The model did not answer during the study phase. The rest of it is skipped rather than failing the same way twice more; the first turn of play then pauses or gives the session up as above |
| `Running post-session analysis... (press ■ Stop again to skip it)` | Stop was pressed during play. Stop now cuts a model request short, so the analysis gets its own chance to run, and a second Stop cancels it (`Post-session analysis skipped.`) |

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
| `Session given up: ... did not accept the API key (HTTP 401)` | Wrong or expired key for that provider. Fix the key and start again |
| `Session given up: ... does not know that model or address (HTTP 404)` / `does not have that model` | The model id is wrong or retired, or (Ollama) not pulled on that host: `ollama pull <model>` there, or pick another model |
| `Session given up: Ollama cannot do what the request asks with this model (HTTP 400): ... does not support tools` | The model lacks something the page asks of it. `tools`: turn on **Small-model mode (JSON actions)**. `vision` or images: pick a model that can see images |
| `Ollama rejected the request 3 times in a row (HTTP 400): ...` then `paused: model unreachable` | Usually the LAN link is cutting request bodies off (Ollama answers 400 after waiting for the rest). The run waits and carries on when requests get through; if it keeps happening, lower **Local screenshot width (px)** so each request is shorter |
| `paused: model unreachable` does not clear | The model host is down or unreachable. Check Ollama is running on the host under **OLLAMA SERVER**, and (with **Relay through local backend** on) that the backend window is open. A request is abandoned after 90 s for cloud providers and 10 minutes for Ollama; a check while paused, after at most 2 minutes |
| `Model request failed after ...: Ollama did not reply in time (the backend relay got no reply from Ollama ...)` | After about 600 s: Ollama took longer than 10 minutes over one turn. After about 20 s: the Ollama host did not answer the connection at all (switched off, wrong address). On a working host the first means the turn is too heavy for the GPU: lower **Local screenshot width (px)** or use a smaller model. The run pauses and checks again rather than retrying the same ten-minute request at once. A backend not yet restarted after a pull is read the same way, from its error text |
| `Session given up: ... (HTTP 400): ...` naming a `tool_use_id`, a `tool` message or a function response, around turn 12 with Anthropic, OpenAI or Gemini | A known problem outside this change: once the conversation window fills, it can start with a tool result whose tool call was trimmed away, and the provider refuses the request. It used to end the game and restart instead. Until the window is trimmed at turn boundaries, **Small-model mode (JSON actions)** avoids it, since it sends no tool blocks |
| Backend window closed | re-run `start.bat`; the watchdog auto-pauses the agent if the backend drops. Then reload any agent tab left open from before: the backend has a new token |
| `⛔ The backend refused this page's token ...` / `⚠ The backend refuses this page (see above: reload it) — auto-paused.` | The backend restarted since the tab loaded. Click **Reload page** (or F5) and start the session again |
| `⛔ This page has no backend token ...` | The tab loaded before the backend had ever started in this folder (no `.agent-token` yet), or the page was not served by `npm run dev`. Run `start.bat`, then reload `http://localhost:5173` |
| `⛔ The backend accepts only the agent page at http://localhost:5173 ...` | The tab is on another address, usually `localhost:5174` from a second `npm run dev` that found 5173 taken. Close the extra window and use `http://localhost:5173` |
| Backend window: `Could not start on port 8765 (...). Is the backend already running in another window?` | A backend is already running (or another program holds port 8765). Close the old backend window first. The new one does not touch the running one's token, so open tabs keep working |
| Backend window: `Could not set up the page's token: ...` | `AGENT_TOKEN` is set but is not 32 to 256 letters, digits, `-` or `_`; or `.agent-token` cannot be written in the project folder (read-only folder, antivirus). Fix or clear `AGENT_TOKEN` and start again |
| An old tab (opened before this update was pulled) shows errors on every action | It predates the token and never sends one. Reload it |
| `start.bat` window: `error when starting dev server: Error: Vite 5.4.x is older than 5.4.12 and does not check the Host header ...` (and the backend window closes) | The Node packages were installed before Vite could keep the page's token from other sites, and `start.bat` installs them only when `node_modules` is missing. Run `npm install` in the project folder, then `start.bat` again |
| `📷 Snapshot not saved — ...` | The backend refused or failed the write (the reason follows). Snapshots are only for troubleshooting; play is not affected |
| `Memory not saved — outcome: Input should be ...` | The page sent an outcome name the backend does not accept, which is a bug. Run `npm run check` (it compares the two lists) and report the log line |
| `Memory not saved — no reply from the backend (HTTP 500, empty); check that the backend window is running. game-agent-memory.json was not updated.` | The backend was down when the session ended (the page and Vite were still up), so that session is not in memory. Re-run `start.bat`; later sessions save normally |
| `Memory not saved — Failed to fetch` | Vite itself was gone (the `npm run dev` window closed) while the page stayed open. Re-run `start.bat` and reload the page |

---

## 7. Safety recap
- **FAILSAFE:** mouse to top-left corner kills all input instantly.
- **Pause-to-think:** offline single-player games only.
- **Anti-cheat:** everything the agent does is synthetic input, not only
  pause-to-think. Keys and clicks are sent with Windows `SendInput`/pyautogui, and
  Windows marks such input as injected (the `LLKHF_INJECTED` / `LLMHF_INJECTED`
  flags a low-level keyboard or mouse hook can read). The gamepad is a virtual
  ViGEm controller, visible as such, and pause-to-think injects a DLL into the
  game. Anti-cheat software can detect any of these, and some also
  judges timing and movement patterns. Use the agent only on offline or
  single-player games without anti-cheat, never on online or competitive games,
  where it can get the account banned.
- **Other web pages:** the backend takes requests only from the agent page with
  this launch's token (see **Only the agent page can use the backend** under
  Launch), so a site open in another tab cannot drive the mouse or read the
  screen. Keep `.agent-token` private.
- The agent controls your real mouse/keyboard/gamepad — keep the game in focus and
  don't leave it unattended on anything that can take destructive actions.
