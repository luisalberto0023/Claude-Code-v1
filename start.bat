@echo off
setlocal
title Game Agent
cd /d "%~dp0"

echo.
echo   Game Agent -- Starting Up
echo   =========================
echo.

:: ── Check .env ────────────────────────────────────────────────────────────────
if not exist ".env" (
    echo   ERROR: No .env file found.
    echo   Copy .env.example to .env and add your API key.
    pause & exit /b 1
)
findstr /c:"your-key-here" ".env" >nul 2>&1
if not errorlevel 1 (
    echo   ERROR: .env still has the placeholder key.
    echo   Open .env and replace the placeholder with your real API key.
    pause & exit /b 1
)
echo   OK: .env found

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
echo   OK: Python packages ready

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
