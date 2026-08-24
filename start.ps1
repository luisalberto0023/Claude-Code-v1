# Game Agent — PowerShell launcher
# Run once as admin to allow scripts: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "  Game Agent -- Starting Up" -ForegroundColor Cyan
Write-Host "  =========================" -ForegroundColor Cyan
Write-Host ""

# .env check — only needed for cloud providers; Ollama (local) needs no key
if (-not (Test-Path ".env")) {
    Write-Host "  NOTE: No .env file found - fine if you are using Ollama (local)." -ForegroundColor Yellow
} elseif (Select-String -Path ".env" -Pattern "your-key-here" -Quiet) {
    Write-Host "  NOTE: .env still has the placeholder key - fine for Ollama (local)." -ForegroundColor Yellow
} else {
    Write-Host "  OK: .env found" -ForegroundColor Green
}

# Python
try { python --version | Out-Null } catch {
    Write-Host "  ERROR: Python not found." -ForegroundColor Red; exit 1
}
Write-Host "  OK: Python found" -ForegroundColor Green

# venv
if (-not (Test-Path ".venv\Scripts\Activate.ps1")) {
    Write-Host "  Creating virtual environment..."
    python -m venv .venv
}
& .\.venv\Scripts\Activate.ps1
Write-Host "  OK: venv active" -ForegroundColor Green

# Python packages
python -m pip install --quiet fastapi uvicorn pyautogui pillow pyperclip 2>$null
Write-Host "  OK: Core Python packages ready" -ForegroundColor Green
# Optional capability packages (gamepad / native capture / pause-to-think).
# Best-effort: failures do not stop the agent — the backend degrades gracefully.
python -m pip install --quiet psutil pygetwindow 2>$null
python -m pip install --quiet vgamepad dxcam xspeedhack 2>$null
Write-Host "  OK: Optional packages checked (gamepad also needs the ViGEmBus driver)" -ForegroundColor Green

# Node
try { node --version | Out-Null } catch {
    Write-Host "  ERROR: Node.js not found." -ForegroundColor Red; exit 1
}
Write-Host "  OK: Node.js found" -ForegroundColor Green

# Node packages
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing Node packages..."
    npm install
}
Write-Host "  OK: Node packages ready" -ForegroundColor Green

# Backend in new window
Write-Host "  Starting backend..."
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PSScriptRoot'; & .\.venv\Scripts\Activate.ps1; python agent_server.py" -WindowStyle Normal
Start-Sleep -Seconds 4
Write-Host "  OK: Backend started" -ForegroundColor Green

# Browser
Start-Process "http://localhost:5173"

# Frontend
Write-Host ""
Write-Host "  Starting frontend... (Ctrl+C to stop)" -ForegroundColor Cyan
Write-Host ""
npm run dev

# Cleanup
Get-Process | Where-Object { $_.MainWindowTitle -like "*agent_server*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Write-Host "  Done." -ForegroundColor Green
