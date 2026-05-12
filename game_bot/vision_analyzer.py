"""
Screen understanding via Claude's multimodal (vision) API.

Every perception cycle produces a rich ScreenAnalysis that tells the agent:
  - What kind of screen this is (tutorial, gameplay, menu, …)
  - What interactive elements are visible and where
  - The current game objective
  - Resource / health / score readings
  - Whether the bot is blocked and why
  - A suggested next action with coordinates

The module uses claude-opus-4-7 for deep analysis and falls back to
claude-sonnet-4-6 for lightweight "is the screen still the same?" checks.
"""

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import anthropic

from .config import config
from .mobile_controller import ScreenState

log = logging.getLogger(__name__)

# ── Data model ────────────────────────────────────────────────────────────────

SCREEN_TYPES = [
    "loading",       # loading screen / splash
    "tutorial",      # in-game tutorial / guided step
    "gameplay",      # active game play
    "menu",          # main menu / sub-menu
    "dialog",        # popup / confirmation dialog
    "shop",          # in-game store
    "inventory",     # items / upgrades screen
    "map",           # level / world map
    "cutscene",      # non-interactive story scene
    "game_over",     # death / fail screen
    "victory",       # level complete / win screen
    "settings",      # settings / options
    "unknown",       # anything else
]


@dataclass
class InteractiveElement:
    label: str           # human-readable name, e.g. "Play button"
    element_type: str    # button | text_field | slider | toggle | icon | area
    nx: float            # normalised x centre (0–1)
    ny: float            # normalised y centre (0–1)
    confidence: float    # 0–1


@dataclass
class ScreenAnalysis:
    screen_type: str
    objective: str                               # what should the bot do RIGHT NOW
    interactive_elements: list[InteractiveElement] = field(default_factory=list)
    game_state: dict[str, Any] = field(default_factory=dict)  # hp, gold, score …
    progress_indicators: dict[str, Any] = field(default_factory=dict)
    blocking_issues: list[str] = field(default_factory=list)
    tutorial_instruction: str = ""               # extracted tutorial text
    suggested_action_type: str = "tap"           # tap | swipe | wait | back | text
    suggested_nx: float = 0.5
    suggested_ny: float = 0.5
    suggested_params: dict[str, Any] = field(default_factory=dict)
    suggested_reasoning: str = ""
    raw_description: str = ""                    # Claude's free-form description
    timestamp: float = field(default_factory=time.time)

    @property
    def is_interactive(self) -> bool:
        return self.screen_type not in ("loading", "cutscene")

    @property
    def is_blocked(self) -> bool:
        return bool(self.blocking_issues)


# ── Analyser ──────────────────────────────────────────────────────────────────

class VisionAnalyzer:
    """
    Converts a raw screenshot into a structured ScreenAnalysis.
    """

    # System prompt injected before every vision call
    _SYSTEM = (
        "You are the perception module of an autonomous mobile game-playing AI. "
        "Your job is to analyse a screenshot and return a precise JSON description "
        "of what you see so the agent can decide its next action. "
        "Always respond with valid JSON only – no markdown fences, no explanation. "
        "Coordinates must be normalised (0.0 = left/top, 1.0 = right/bottom)."
    )

    _ANALYSIS_SCHEMA = """
Return a JSON object with EXACTLY these keys:

{
  "screen_type": "<one of: loading|tutorial|gameplay|menu|dialog|shop|inventory|map|cutscene|game_over|victory|settings|unknown>",
  "objective": "<one sentence – what should the bot do right now>",
  "tutorial_instruction": "<verbatim text of the tutorial hint, or empty string>",
  "interactive_elements": [
    {
      "label": "<descriptive name>",
      "element_type": "<button|text_field|slider|toggle|icon|area>",
      "nx": <0.0–1.0>,
      "ny": <0.0–1.0>,
      "confidence": <0.0–1.0>
    }
  ],
  "game_state": {
    "health": <number or null>,
    "mana": <number or null>,
    "gold": <number or null>,
    "score": <number or null>,
    "level": <number or null>,
    "lives": <number or null>,
    "other": {}
  },
  "progress_indicators": {
    "quest_progress": "<text or null>",
    "tutorial_step": <number or null>,
    "stars": <number or null>,
    "completion_percent": <number or null>
  },
  "blocking_issues": ["<describe each obstacle preventing progress>"],
  "suggested_action": {
    "type": "<tap|swipe|long_press|scroll_down|scroll_up|wait|back|text_input>",
    "nx": <0.0–1.0>,
    "ny": <0.0–1.0>,
    "params": {},
    "reasoning": "<why this action>"
  },
  "raw_description": "<2–3 sentence description of what you see>"
}
"""

    def __init__(self):
        if not config.anthropic_api_key:
            raise ValueError(
                "ANTHROPIC_API_KEY is not set. "
                "Export it before running: export ANTHROPIC_API_KEY=sk-ant-..."
            )
        self._client = anthropic.Anthropic(api_key=config.anthropic_api_key)
        self._last_call_time = 0.0
        self._min_call_gap = 60.0 / config.max_api_calls_per_minute

    def analyse(self, screen: ScreenState, context: str = "") -> ScreenAnalysis:
        """
        Full deep analysis of a screenshot.
        `context` may contain recent action history or game knowledge to help
        Claude make better decisions.
        """
        self._rate_limit()

        user_content = [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": screen.image_base64,
                },
            },
            {
                "type": "text",
                "text": (
                    "Analyse this mobile game screenshot.\n\n"
                    + (f"Context from recent history:\n{context}\n" if context else "")
                    + self._ANALYSIS_SCHEMA
                ),
            },
        ]

        try:
            response = self._client.messages.create(
                model=config.reasoning_model,
                max_tokens=2048,
                system=self._SYSTEM,
                messages=[{"role": "user", "content": user_content}],
            )
            raw_json = response.content[0].text.strip()
            return self._parse(raw_json, screen)
        except Exception as e:
            log.error("Vision analysis failed: %s", e)
            return self._fallback_analysis(screen)

    def is_same_screen(self, screen_a: ScreenState, screen_b: ScreenState) -> bool:
        """
        Quick lightweight check – did the screen change between two captures?
        Uses a fast model and a short prompt to keep costs low.
        """
        self._rate_limit()
        try:
            response = self._client.messages.create(
                model=config.action_model,
                max_tokens=16,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "text",
                                "text": "These are two consecutive mobile game screenshots. "
                                        "Reply with exactly one word: SAME or DIFFERENT.",
                            },
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": screen_a.image_base64,
                                },
                            },
                            {
                                "type": "image",
                                "source": {
                                    "type": "base64",
                                    "media_type": "image/png",
                                    "data": screen_b.image_base64,
                                },
                            },
                        ],
                    }
                ],
            )
            return "SAME" in response.content[0].text.upper()
        except Exception:
            return False

    # ── Parsing helpers ───────────────────────────────────────────────────────

    def _parse(self, raw_json: str, screen: ScreenState) -> ScreenAnalysis:
        # Strip any accidental markdown fences
        raw_json = re.sub(r"^```[a-z]*\n?", "", raw_json)
        raw_json = re.sub(r"\n?```$", "", raw_json)

        try:
            data = json.loads(raw_json)
        except json.JSONDecodeError as e:
            log.warning("JSON parse failed (%s); raw=%r", e, raw_json[:200])
            return self._fallback_analysis(screen)

        elements = [
            InteractiveElement(
                label=el.get("label", "unknown"),
                element_type=el.get("element_type", "button"),
                nx=float(el.get("nx", 0.5)),
                ny=float(el.get("ny", 0.5)),
                confidence=float(el.get("confidence", 0.5)),
            )
            for el in data.get("interactive_elements", [])
        ]

        sa = data.get("suggested_action", {})
        return ScreenAnalysis(
            screen_type=data.get("screen_type", "unknown"),
            objective=data.get("objective", ""),
            interactive_elements=elements,
            game_state=data.get("game_state", {}),
            progress_indicators=data.get("progress_indicators", {}),
            blocking_issues=data.get("blocking_issues", []),
            tutorial_instruction=data.get("tutorial_instruction", ""),
            suggested_action_type=sa.get("type", "tap"),
            suggested_nx=float(sa.get("nx", 0.5)),
            suggested_ny=float(sa.get("ny", 0.5)),
            suggested_params=sa.get("params", {}),
            suggested_reasoning=sa.get("reasoning", ""),
            raw_description=data.get("raw_description", ""),
            timestamp=screen.timestamp,
        )

    @staticmethod
    def _fallback_analysis(screen: ScreenState) -> ScreenAnalysis:
        return ScreenAnalysis(
            screen_type="unknown",
            objective="Wait and observe – analysis failed",
            suggested_action_type="wait",
            raw_description="Vision analysis unavailable",
            timestamp=screen.timestamp,
        )

    def _rate_limit(self) -> None:
        elapsed = time.time() - self._last_call_time
        if elapsed < self._min_call_gap:
            time.sleep(self._min_call_gap - elapsed)
        self._last_call_time = time.time()
