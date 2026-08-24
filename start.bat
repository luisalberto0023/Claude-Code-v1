@echo off
setlocal
title Game Agent
cd /d "%~dp0"

echo.
echo   Game Agent -- Starting Up
echo   =========================
echo.

:: ── Check .env (only needed for cloud providers) ──────────────────────────────
:: A local Ollama model needs no API key, so a missing/placeholder .env is a
:: warning rather than a hard stop.
if not exist ".env" (
    echo   NOTE: No .env file found — fine if you are using Ollama ^(local^).
    echo         For Anthropic/OpenAI/Gemini, copy .env.example to .env and add a key.
) else (
    findstr /c:"your-key-here" ".env" >nul 2>&1
    if not errorlevel 1 (
        echo   NOTE: .env still has the placeholder key — fine for Ollama ^(local^).
    ) else (
        echo   OK: .env found
    )
)

:: ── Check Python ──────────────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Python not found. Install from python.org
    pause & exit /b 1
)
echo   OK: Python found

:: ── Create venv if needed ─────────────────────────────────────────────────────
if not exist ".venv\Scripts\activate.bat" (
    echo   Creating virtual environment...
    python -m venv .venv
)
echo   OK: Virtual environment ready

:: ── Activate venv ─────────────────────────────────────────────────────────────
call ".venv\Scripts\activate.bat"
echo   OK: Virtual environment active

:: ── Install Python packages ───────────────────────────────────────────────────
echo   Checking Python packages...
python -m pip install --quiet fastapi uvicorn pyautogui pillow pyperclip 2>nul
echo   OK: Core Python packages ready
:: Optional capability packages (gamepad / native capture / pause-to-think).
:: Best-effort: failures here do not stop the agent — the backend degrades gracefully.
echo   Checking optional packages (gamepad, capture, windows)...
python -m pip install --quiet psutil pygetwindow 2>nul
python -m pip install --quiet vgamepad dxcam xspeedhack 2>nul
echo   OK: Optional packages checked (gamepad needs the ViGEmBus driver too)

:: ── Check Node ────────────────────────────────────────────────────────────────
node --version >nul 2>&1
if errorlevel 1 (
    echo   ERROR: Node.js not found. Install from nodejs.org
    pause & exit /b 1
)
echo   OK: Node.js found

:: ── Install Node packages if needed ──────────────────────────────────────────
if not exist "node_modules" (
    echo   Installing Node packages, please wait...
    npm install
)
echo   OK: Node packages ready

:: ── Start backend in a new window ─────────────────────────────────────────────
echo   Starting backend server...
set ACTIVATE=.venv\Scripts\activate.bat
start "Game Agent Backend" cmd /k "cd /d %~s0\.. && call %ACTIVATE% && python agent_server.py"
timeout /t 4 /nobreak >nul
echo   OK: Backend started

:: ── Open browser ──────────────────────────────────────────────────────────────
start "" "http://localhost:5173"

:: ── Start frontend (blocks until you press Ctrl+C) ────────────────────────────
echo.
echo   Starting frontend... (press Ctrl+C to stop everything)
echo.
npm run dev

:: ── Cleanup ───────────────────────────────────────────────────────────────────
echo.
echo   Stopping backend...
taskkill /fi "WindowTitle eq Game Agent Backend" /f >nul 2>&1
echo   Done. Goodbye!
pause
endlocal
