"""
Central configuration for the autonomous game bot.
All tunable parameters live here so the rest of the codebase stays clean.
"""

import os
from dataclasses import dataclass, field


@dataclass
class BotConfig:
    # ── Anthropic ────────────────────────────────────────────────────────────
    anthropic_api_key: str = field(
        default_factory=lambda: os.getenv("ANTHROPIC_API_KEY", "")
    )
    # Heavy reasoning: game planning, reflection, tutorial understanding
    reasoning_model: str = "claude-opus-4-7"
    # Fast decisions: moment-to-moment action selection during gameplay
    action_model: str = "claude-sonnet-4-6"

    # ── ADB / Device ─────────────────────────────────────────────────────────
    adb_device: str = field(
        default_factory=lambda: os.getenv("ADB_DEVICE", "")
    )  # empty = auto-detect first connected device
    adb_path: str = "adb"  # path to adb binary
    screenshot_interval: float = 2.0  # seconds between perception cycles
    action_delay: float = 0.8  # seconds to wait after each action for UI to settle
    long_press_duration: int = 1000  # milliseconds for long-press actions

    # ── Screen ───────────────────────────────────────────────────────────────
    # Bot works in normalised coordinates (0.0–1.0); controller maps to pixels
    screen_width: int = 1080
    screen_height: int = 1920

    # ── Learning ─────────────────────────────────────────────────────────────
    reflect_every_n_actions: int = 25   # trigger deep reflection after N actions
    stuck_threshold: int = 12           # consecutive no-progress actions → stuck
    max_retry_same_action: int = 3      # before trying something different
    exploration_rate: float = 0.15      # chance to try a random novel action

    # ── Persistence ──────────────────────────────────────────────────────────
    db_path: str = "game_bot.db"
    screenshots_dir: str = "screenshots"
    max_screenshot_history: int = 500   # rotate old screenshots

    # ── Game targeting ───────────────────────────────────────────────────────
    game_package: str = field(
        default_factory=lambda: os.getenv("GAME_PACKAGE", "")
    )  # Android package name, e.g. "com.supercell.clashofclans"
    game_activity: str = ""             # optional specific activity to launch

    # ── Safety limits ────────────────────────────────────────────────────────
    max_session_actions: int = 5000     # stop after this many actions per run
    max_api_calls_per_minute: int = 20  # rate-limit guard


# Singleton used throughout the project
config = BotConfig()
