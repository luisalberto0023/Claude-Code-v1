"""
Learning engine – the bot's capacity to reflect and improve.

After every N actions (configurable) the engine performs a "reflection":
  1. Reviews recent actions and outcomes
  2. Extracts new game knowledge
  3. Updates / creates strategies
  4. Identifies recurring failure patterns
  5. Proposes a recovery plan when the bot is stuck

Uses claude-opus-4-7 for deep reflective reasoning.
"""

import json
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import anthropic

from .config import config
from .memory_system import Achievement, MemorySystem, Strategy
from .vision_analyzer import ScreenAnalysis

log = logging.getLogger(__name__)


@dataclass
class ReflectionResult:
    new_knowledge: list[dict[str, str]]   # [{category, fact, details}]
    new_strategies: list[dict]            # [{situation, action_type, nx, ny, params, desc}]
    updated_strategies: list[dict]        # same structure, for existing ones
    failure_patterns: list[str]
    recovery_plan: str                    # what to try when stuck
    summary: str                          # human-readable summary of what was learned
    raw: str                              # raw Claude output for debugging


class LearningEngine:
    """
    Periodic reflection loop that turns raw experience into structured knowledge.
    """

    _SYSTEM = (
        "You are the learning module of an autonomous mobile game-playing AI. "
        "You analyse the bot's recent experience and extract reusable knowledge. "
        "Respond ONLY with valid JSON – no markdown, no prose outside the JSON."
    )

    _REFLECTION_TEMPLATE = """
The bot is playing a mobile game autonomously.

=== GAME KNOWLEDGE SO FAR ===
{knowledge}

=== STRATEGIES LEARNED SO FAR ===
{strategies}

=== ACHIEVEMENTS ===
{achievements}

=== LAST {n} ACTIONS (oldest first) ===
{actions}

=== CURRENT SCREEN ===
screen_type: {screen_type}
objective: {objective}
blocking_issues: {blocking}

=== TASK ===
Analyse the above and return a JSON object with exactly these keys:

{{
  "new_knowledge": [
    {{"category": "<controls|mechanics|ui|enemy|level|economy|story|meta>",
      "fact": "<short unique fact>",
      "details": "<elaboration>",
      "confidence": <0.0–1.0>}}
  ],
  "new_strategies": [
    {{"situation": "<concise situation key>",
      "action_type": "<tap|swipe|long_press|scroll_down|scroll_up|wait|back|text_input>",
      "nx": <0.0–1.0>,
      "ny": <0.0–1.0>,
      "params": {{}},
      "description": "<what this achieves>"}}
  ],
  "updated_strategies": [],
  "failure_patterns": ["<pattern 1>", ...],
  "recovery_plan": "<concrete next step when stuck>",
  "summary": "<2–3 sentences on what was learned>"
}}

Rules:
- Only include facts that are clearly supported by the action history.
- Coordinates must be 0.0–1.0 normalised floats.
- If nothing new was learned, return empty lists but still provide a recovery_plan and summary.
"""

    def __init__(self, memory: MemorySystem):
        self._memory = memory
        self._client = anthropic.Anthropic(api_key=config.anthropic_api_key)
        self._last_reflection_count = 0

    def should_reflect(self) -> bool:
        """True when enough new actions have accumulated since the last reflection."""
        total = self._memory.action_count()
        return (total - self._last_reflection_count) >= config.reflect_every_n_actions

    def reflect(self, current_analysis: ScreenAnalysis) -> ReflectionResult:
        """
        Run a full reflection cycle against recent experience.
        Stores extracted knowledge and strategies back into memory.
        """
        n = config.reflect_every_n_actions
        prompt = self._REFLECTION_TEMPLATE.format(
            knowledge=self._memory.knowledge_summary(30),
            strategies=self._memory.strategies_summary(),
            achievements=self._memory.achievements_summary(),
            actions=self._memory.recent_actions_summary(n),
            n=n,
            screen_type=current_analysis.screen_type,
            objective=current_analysis.objective,
            blocking=", ".join(current_analysis.blocking_issues) or "none",
        )

        try:
            response = self._client.messages.create(
                model=config.reasoning_model,
                max_tokens=3000,
                system=self._SYSTEM,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.content[0].text.strip()
            result = self._parse(raw)
        except Exception as e:
            log.error("Reflection failed: %s", e)
            result = ReflectionResult(
                new_knowledge=[], new_strategies=[], updated_strategies=[],
                failure_patterns=[], recovery_plan="Wait and observe",
                summary="Reflection unavailable", raw=str(e),
            )

        self._apply(result)
        self._last_reflection_count = self._memory.action_count()
        log.info(
            "Reflection done – %d knowledge, %d strategies, summary: %s",
            len(result.new_knowledge), len(result.new_strategies), result.summary,
        )
        return result

    def detect_achievement(
        self,
        before: ScreenAnalysis,
        after: ScreenAnalysis,
        action_count: int,
    ) -> list[Achievement]:
        """
        Compare screen states before/after an action and surface achievements.
        Uses a lightweight heuristic check, not a full API call.
        """
        achievements = []

        # Tutorial completion
        if before.screen_type == "tutorial" and after.screen_type != "tutorial":
            achievements.append(Achievement(
                title="Tutorial Completed",
                description=f"Moved from tutorial to {after.screen_type}",
                screen_type=after.screen_type,
                action_count_at_time=action_count,
            ))

        # Level / victory transition
        if after.screen_type == "victory":
            level = after.game_state.get("level") or before.game_state.get("level")
            achievements.append(Achievement(
                title=f"Level {level} Cleared" if level else "Level Cleared",
                description=after.objective or "Reached victory screen",
                screen_type="victory",
                action_count_at_time=action_count,
            ))

        # Progress milestone
        for key in ("level", "score", "stars"):
            old_val = before.game_state.get(key)
            new_val = after.game_state.get(key)
            if old_val and new_val and new_val > old_val:
                achievements.append(Achievement(
                    title=f"{key.capitalize()} Increased",
                    description=f"{key} went from {old_val} to {new_val}",
                    screen_type=after.screen_type,
                    action_count_at_time=action_count,
                ))

        return achievements

    def build_recovery_plan(self, current_analysis: ScreenAnalysis) -> list[dict]:
        """
        When the bot is stuck, ask Claude for a fresh recovery strategy.
        Returns a list of action dicts: [{type, nx, ny, params, reasoning}]
        """
        prompt = f"""
The game bot is STUCK. Last {config.stuck_threshold} actions had no visible effect.

Current screen: {current_analysis.screen_type}
Objective: {current_analysis.objective}
Blocking issues: {', '.join(current_analysis.blocking_issues) or 'none'}
Known strategies: {self._memory.strategies_summary(current_analysis.screen_type)}
Game knowledge: {self._memory.knowledge_summary(15)}

Propose up to 5 recovery actions to try (in order). Return JSON:
{{
  "recovery_actions": [
    {{
      "type": "<tap|swipe|scroll_down|scroll_up|back|wait|long_press>",
      "nx": <0.0–1.0>,
      "ny": <0.0–1.0>,
      "params": {{}},
      "reasoning": "<why this might help>"
    }}
  ]
}}
"""
        try:
            response = self._client.messages.create(
                model=config.reasoning_model,
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )
            raw = response.content[0].text.strip()
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)
            data = json.loads(raw)
            return data.get("recovery_actions", [])
        except Exception as e:
            log.error("Recovery plan generation failed: %s", e)
            # Hard-coded fallback escalation
            return [
                {"type": "back", "nx": 0.5, "ny": 0.5, "params": {}, "reasoning": "escape current screen"},
                {"type": "scroll_down", "nx": 0.5, "ny": 0.5, "params": {}, "reasoning": "look for hidden elements"},
                {"type": "tap", "nx": 0.5, "ny": 0.5, "params": {}, "reasoning": "tap centre"},
                {"type": "wait", "nx": 0.5, "ny": 0.5, "params": {"seconds": 5}, "reasoning": "wait for loading"},
            ]

    def extract_tutorial_knowledge(self, analysis: ScreenAnalysis) -> None:
        """Parse tutorial text from a screen and store it as game knowledge."""
        if not analysis.tutorial_instruction:
            return
        self._memory.add_knowledge(
            category="mechanics",
            fact=f"tutorial_step: {analysis.tutorial_instruction[:80]}",
            details=analysis.tutorial_instruction,
            confidence=0.95,
        )

    # ── Internals ─────────────────────────────────────────────────────────────

    def _parse(self, raw: str) -> ReflectionResult:
        raw_clean = re.sub(r"^```[a-z]*\n?", "", raw)
        raw_clean = re.sub(r"\n?```$", "", raw_clean)
        try:
            data = json.loads(raw_clean)
        except json.JSONDecodeError as e:
            log.warning("Reflection JSON parse failed: %s – raw=%r", e, raw[:200])
            return ReflectionResult(
                new_knowledge=[], new_strategies=[], updated_strategies=[],
                failure_patterns=[], recovery_plan="Retry with back button",
                summary="Parse error in reflection", raw=raw,
            )
        return ReflectionResult(
            new_knowledge=data.get("new_knowledge", []),
            new_strategies=data.get("new_strategies", []),
            updated_strategies=data.get("updated_strategies", []),
            failure_patterns=data.get("failure_patterns", []),
            recovery_plan=data.get("recovery_plan", ""),
            summary=data.get("summary", ""),
            raw=raw,
        )

    def _apply(self, result: ReflectionResult) -> None:
        """Persist extracted knowledge and strategies to memory."""
        for k in result.new_knowledge:
            try:
                self._memory.add_knowledge(
                    category=k.get("category", "general"),
                    fact=k.get("fact", ""),
                    details=k.get("details", ""),
                    confidence=float(k.get("confidence", 1.0)),
                )
            except Exception as e:
                log.warning("Could not store knowledge item: %s", e)

        for s in result.new_strategies + result.updated_strategies:
            try:
                strategy = Strategy(
                    situation=s.get("situation", "unknown"),
                    action_type=s.get("action_type", "tap"),
                    nx=float(s.get("nx", 0.5)),
                    ny=float(s.get("ny", 0.5)),
                    params=s.get("params", {}),
                    description=s.get("description", ""),
                )
                self._memory.upsert_strategy(strategy)
            except Exception as e:
                log.warning("Could not store strategy: %s", e)
