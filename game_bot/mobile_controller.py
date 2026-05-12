"""
Android device control via ADB (Android Debug Bridge).

Responsibilities:
  - Capture screenshots
  - Send touch events: tap, swipe, long-press, scroll, pinch
  - Send text input and key events
  - Launch / detect running game
  - Query device screen dimensions
"""

import base64
import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Tuple

from .config import config

log = logging.getLogger(__name__)


@dataclass
class ScreenState:
    """Raw screenshot + metadata returned from the device."""
    image_base64: str          # PNG encoded as base64 for Claude Vision
    image_path: str            # local file path where PNG was saved
    width: int
    height: int
    timestamp: float


class MobileController:
    """
    Thin wrapper around ADB shell commands.
    All coordinates passed IN are normalised (0.0–1.0).
    They are converted to pixels internally before sending to the device.
    """

    def __init__(self):
        self._device_flag = f"-s {config.adb_device}" if config.adb_device else ""
        self._shot_counter = 0
        Path(config.screenshots_dir).mkdir(parents=True, exist_ok=True)
        self._width, self._height = self._detect_screen_size()
        log.info("MobileController ready – screen %dx%d", self._width, self._height)

    # ── Public API ────────────────────────────────────────────────────────────

    def capture_screen(self) -> ScreenState:
        """Take a screenshot, save it locally, return a ScreenState."""
        self._shot_counter += 1
        filename = f"{config.screenshots_dir}/shot_{self._shot_counter:06d}.png"

        # Pull screenshot bytes directly (faster than adb pull)
        raw = self._adb_exec("exec-out screencap -p")
        with open(filename, "wb") as f:
            f.write(raw)

        b64 = base64.b64encode(raw).decode()
        self._rotate_old_screenshots()
        return ScreenState(
            image_base64=b64,
            image_path=filename,
            width=self._width,
            height=self._height,
            timestamp=time.time(),
        )

    def tap(self, nx: float, ny: float) -> None:
        """Tap at normalised coordinates (0–1)."""
        x, y = self._to_pixels(nx, ny)
        log.debug("TAP  %.3f,%.3f → %d,%d", nx, ny, x, y)
        self._adb_shell(f"input tap {x} {y}")
        time.sleep(config.action_delay)

    def swipe(
        self,
        from_nx: float, from_ny: float,
        to_nx: float, to_ny: float,
        duration_ms: int = 300,
    ) -> None:
        """Swipe from one normalised point to another."""
        x1, y1 = self._to_pixels(from_nx, from_ny)
        x2, y2 = self._to_pixels(to_nx, to_ny)
        log.debug("SWIPE %d,%d → %d,%d (%dms)", x1, y1, x2, y2, duration_ms)
        self._adb_shell(f"input swipe {x1} {y1} {x2} {y2} {duration_ms}")
        time.sleep(config.action_delay)

    def long_press(self, nx: float, ny: float) -> None:
        """Long-press at normalised coordinates."""
        x, y = self._to_pixels(nx, ny)
        log.debug("LONG_PRESS %d,%d", x, y)
        self._adb_shell(
            f"input swipe {x} {y} {x} {y} {config.long_press_duration}"
        )
        time.sleep(config.action_delay)

    def scroll_down(self, nx: float = 0.5, distance: float = 0.3) -> None:
        """Scroll downward by `distance` screen-heights at horizontal position nx."""
        self.swipe(nx, 0.5 + distance / 2, nx, 0.5 - distance / 2, duration_ms=400)

    def scroll_up(self, nx: float = 0.5, distance: float = 0.3) -> None:
        self.swipe(nx, 0.5 - distance / 2, nx, 0.5 + distance / 2, duration_ms=400)

    def pinch_in(self, cx: float = 0.5, cy: float = 0.5, spread: float = 0.2) -> None:
        """Two-finger pinch-in (zoom out)."""
        self._two_finger_gesture(cx, cy, spread, spread * 0.1)

    def pinch_out(self, cx: float = 0.5, cy: float = 0.5, spread: float = 0.1) -> None:
        """Two-finger pinch-out (zoom in)."""
        self._two_finger_gesture(cx, cy, spread, spread * 2.5)

    def type_text(self, text: str) -> None:
        """Type text into the currently focused field."""
        # ADB requires escaping spaces and special chars
        safe = text.replace(" ", "%s").replace("'", "\\'")
        log.debug("TYPE  %r", text)
        self._adb_shell(f"input text '{safe}'")
        time.sleep(config.action_delay)

    def press_back(self) -> None:
        self._adb_shell("input keyevent 4")
        time.sleep(config.action_delay)

    def press_home(self) -> None:
        self._adb_shell("input keyevent 3")
        time.sleep(config.action_delay)

    def press_enter(self) -> None:
        self._adb_shell("input keyevent 66")
        time.sleep(config.action_delay)

    def launch_game(self) -> bool:
        """Start the game app. Returns True if launch command succeeded."""
        if not config.game_package:
            log.warning("No game_package configured – cannot launch")
            return False

        cmd = f"monkey -p {config.game_package} -c android.intent.category.LAUNCHER 1"
        if config.game_activity:
            cmd = (
                f"am start -n {config.game_package}/{config.game_activity}"
            )
        self._adb_shell(cmd)
        time.sleep(3)  # give the app time to start
        return True

    def is_game_running(self) -> bool:
        """Check whether the game process is in the foreground."""
        if not config.game_package:
            return True  # can't check; assume yes
        result = self._adb_shell_text(
            "dumpsys activity activities | grep mResumedActivity"
        )
        return config.game_package in result

    def get_screen_size(self) -> Tuple[int, int]:
        return self._width, self._height

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _to_pixels(self, nx: float, ny: float) -> Tuple[int, int]:
        return int(nx * self._width), int(ny * self._height)

    def _detect_screen_size(self) -> Tuple[int, int]:
        try:
            out = self._adb_shell_text("wm size")
            # "Physical size: 1080x1920"
            for part in out.split():
                if "x" in part and part.replace("x", "").isdigit():
                    w, h = part.split("x")
                    return int(w), int(h)
        except Exception as e:
            log.warning("Could not detect screen size (%s); using defaults", e)
        return config.screen_width, config.screen_height

    def _two_finger_gesture(
        self,
        cx: float, cy: float,
        start_spread: float, end_spread: float,
        duration_ms: int = 400,
    ) -> None:
        # ADB sendevent is complex; use the simpler approach via shell script
        px, py = self._to_pixels(cx, cy)
        sx1 = int((cx - start_spread) * self._width)
        sx2 = int((cx + start_spread) * self._width)
        ex1 = int((cx - end_spread) * self._width)
        ex2 = int((cx + end_spread) * self._width)
        # Compose two simultaneous swipes using separate processes (close enough)
        self._adb_shell(
            f"input swipe {sx1} {py} {ex1} {py} {duration_ms} & "
            f"input swipe {sx2} {py} {ex2} {py} {duration_ms}"
        )
        time.sleep(config.action_delay)

    def _adb_exec(self, cmd: str) -> bytes:
        """Run an adb command and return raw bytes."""
        full = f"{config.adb_path} {self._device_flag} {cmd}".strip()
        result = subprocess.run(
            full, shell=True, capture_output=True, timeout=30
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"ADB command failed: {full}\n{result.stderr.decode(errors='replace')}"
            )
        return result.stdout

    def _adb_shell(self, cmd: str) -> bytes:
        return self._adb_exec(f"shell {cmd}")

    def _adb_shell_text(self, cmd: str) -> str:
        return self._adb_shell(cmd).decode(errors="replace").strip()

    def _rotate_old_screenshots(self) -> None:
        shots = sorted(Path(config.screenshots_dir).glob("shot_*.png"))
        if len(shots) > config.max_screenshot_history:
            for old in shots[: len(shots) - config.max_screenshot_history]:
                old.unlink(missing_ok=True)
