"""
GameAgent – the top-level orchestrator.

The agent runs a continuous perception-decision-action loop:

  ┌──────────────────────────────────────────────────────────┐
  │  PERCEIVE  →  DECIDE  →  ACT  →  EVALUATE  →  LEARN     │
  │      ↑                                          │        │
  │      └──────────────────────────────────────────┘        │
  └──────────────────────────────────────────────────────────┘

Perceive  – take a screenshot, run VisionAnalyzer
Decide    – pick the best next action (vision suggestion + strategy memory)
Act       – dispatch via ActionExecutor
Evaluate  – classify outcome, detect achievements, check if stuck
Learn     – periodic reflection via LearningEngine; extract tutorial knowledge

The agent models all aspects of a human gamer:
  • Completes tutorials by following on-screen instructions
  • Adapts strategy based on past successes and failures
  • Explores when stuck rather than hammering the same button
  • Tracks achievements and progress
  • Knows when it truly cannot progress and stops gracefully
"""

import logging
import random
import time
from dataclasses import dataclass
from typing import Optional

import anthropic

from .action_executor import (
    OUTCOME_FAILURE,
    OUTCOME_NO_CHANGE,
    OUTCOME_PROGRESS,
    OUTCOME_SUCCESS,
    ActionExecutor,
)
from .config import config
from .learning_engine import LearningEngine
from .memory_system import Achievement, MemorySystem
from .mobile_controller import MobileController, ScreenState
from .vision_analyzer import ScreenAnalysis, VisionAnalyzer

log = logging.getLogger(__name__)

# How many consecutive perception cycles with "same screen" before declaring victory
_GAME_COMPLETE_THRESHOLD = 30
# After this many stuck-recovery attempts with zero progress we stop
_MAX_RECOVERY_ATTEMPTS = 5


@dataclass
class AgentStatus:
    running: bool
    total_actions: int
    session_id: int
    last_screen_type: str
    last_outcome: str
    consecutive_stuck: int
    achievements: int


class GameAgent:
    """
    Autonomous game-playing agent.

    Usage:
        agent = GameAgent()
        agent.run()
    """

    def __init__(self):
        log.info("Initialising GameAgent …")
        self._memory   = MemorySystem()
        self._ctrl     = MobileController()
        self._analyzer = VisionAnalyzer()
        self._executor = ActionExecutor(self._ctrl, self._analyzer, self._memory)
        self._learner  = LearningEngine(self._memory)
        self._client   = anthropic.Anthropic(api_key=config.anthropic_api_key)

        self._session_id: int = 0
        self._running: bool = False
        self._recovery_attempts: int = 0
        self._last_analysis: Optional[ScreenAnalysis] = None
        self._prev_screen: Optional[ScreenState] = None
        self._same_screen_count: int = 0

    # ── Public API ────────────────────────────────────────────────────────────

    def run(self) -> None:
        """Main entry point – blocks until the game is complete or the limit is hit."""
        self._session_id = self._memory.start_session()
        self._running = True
        log.info("Session %d started", self._session_id)

        # Ensure game is running
        if config.game_package and not self._ctrl.is_game_running():
            log.info("Launching game …")
            self._ctrl.launch_game()
            time.sleep(4)

        try:
            self._loop()
        except KeyboardInterrupt:
            log.info("Interrupted by user")
        except Exception as e:
            log.exception("Fatal error in agent loop: %s", e)
        finally:
            self._shutdown()

    def status(self) -> AgentStatus:
        return AgentStatus(
            running=self._running,
            total_actions=self._memory.action_count(),
            session_id=self._session_id,
            last_screen_type=self._last_analysis.screen_type if self._last_analysis else "–",
            last_outcome="–",
            consecutive_stuck=self._executor.consecutive_no_change,
            achievements=len(self._memory.get_achievements()),
        )

    # ── Core loop ─────────────────────────────────────────────────────────────

    def _loop(self) -> None:
        while self._running:
            total = self._memory.action_count()

            if total >= config.max_session_actions:
                log.info("Reached max session actions (%d). Stopping.", total)
                break

            # ── 1. PERCEIVE ──────────────────────────────────────────────
            screen = self._ctrl.capture_screen()
            time.sleep(config.screenshot_interval * 0.3)  # brief stabilise

            # Build context string for the vision call
            context = self._build_perception_context()
            analysis = self._analyzer.analyse(screen, context)
            self._last_analysis = analysis

            log.info(
                "[%d] %-12s | %s",
                total, analysis.screen_type, analysis.objective[:70],
            )

            # ── 2. EXTRACT TUTORIAL KNOWLEDGE ────────────────────────────
            if analysis.screen_type == "tutorial":
                self._learner.extract_tutorial_knowledge(analysis)

            # ── 3. CHECK FOR GAME COMPLETION ─────────────────────────────
            if self._is_game_complete(screen, analysis):
                log.info("Game appears to be fully complete. Stopping.")
                break

            # ── 4. CHECK IF STUCK ────────────────────────────────────────
            if self._memory.is_stuck():
                log.warning("Bot is STUCK – triggering recovery")
                recovered = self._recover(screen, analysis)
                if not recovered:
                    self._recovery_attempts += 1
                    if self._recovery_attempts >= _MAX_RECOVERY_ATTEMPTS:
                        log.info(
                            "Cannot progress after %d recovery attempts. "
                            "Game may be at its limit.",
                            _MAX_RECOVERY_ATTEMPTS,
                        )
                        break
                else:
                    self._recovery_attempts = 0
                continue

            # ── 5. DECIDE ACTION ─────────────────────────────────────────
            action = self._decide(analysis)

            # ── 6. ACT ───────────────────────────────────────────────────
            result = self._executor.execute_with_retry(
                action, screen, analysis,
                max_retries=config.max_retry_same_action,
            )

            # ── 7. EVALUATE & DETECT ACHIEVEMENTS ────────────────────────
            if result.outcome in (OUTCOME_PROGRESS, OUTCOME_SUCCESS):
                # Need the post-action screen analysis to detect achievements
                post_analysis = self._analyzer.analyse(result.screen_after)
                achievements = self._learner.detect_achievement(
                    analysis, post_analysis, self._memory.action_count()
                )
                for ach in achievements:
                    is_new = self._memory.record_achievement(ach)
                    if is_new:
                        log.info("🏆  %s – %s", ach.title, ach.description)
                self._last_analysis = post_analysis

            # ── 8. PERIODIC REFLECTION ────────────────────────────────────
            if self._learner.should_reflect():
                log.info("Triggering reflection …")
                refl = self._learner.reflect(analysis)
                if refl.failure_patterns:
                    log.info("Failure patterns: %s", "; ".join(refl.failure_patterns))
                log.info("Learned: %s", refl.summary)

            self._prev_screen = result.screen_after
            time.sleep(config.screenshot_interval * 0.5)

    # ── Decision making ───────────────────────────────────────────────────────

    def _decide(self, analysis: ScreenAnalysis) -> dict:
        """
        Choose the next action.

        Priority order:
          1. If screen is a tutorial  →  follow the tutorial instruction
          2. Check memory for a proven strategy for this situation
          3. Use VisionAnalyzer's suggestion (Claude already reasoned about it)
          4. Exploration: occasionally try something novel
        """
        total = self._memory.action_count()

        # 1. Tutorial mode: always follow the tutorial
        if analysis.screen_type == "tutorial" and analysis.tutorial_instruction:
            return self._decide_tutorial(analysis)

        # 2. Known strategy for this screen type
        strategies = self._memory.get_strategies(analysis.screen_type)
        if strategies and random.random() > config.exploration_rate:
            best = max(strategies, key=lambda s: s.success_rate * (s.success_count + 1))
            if best.success_rate > 0.5 and best.success_count >= 2:
                log.debug("Using strategy: %s (%.0f%%)", best.description, best.success_rate * 100)
                return {
                    "type": best.action_type,
                    "nx": best.nx,
                    "ny": best.ny,
                    "params": best.params,
                    "reasoning": f"[Strategy] {best.description}",
                }

        # 3. Vision-suggested action (default path)
        action = {
            "type": analysis.suggested_action_type,
            "nx": analysis.suggested_nx,
            "ny": analysis.suggested_ny,
            "params": analysis.suggested_params,
            "reasoning": analysis.suggested_reasoning,
        }

        # 4. Exploration jitter – slightly perturb coordinates to find new elements
        if random.random() < config.exploration_rate:
            action = self._exploration_action(analysis)

        return action

    def _decide_tutorial(self, analysis: ScreenAnalysis) -> dict:
        """
        In tutorial screens, the bot must follow on-screen instructions precisely.
        The vision analyzer has already extracted the instruction and suggested
        where to tap; we trust it here.
        """
        # If there's an arrow or highlighted element, tap the highest-confidence one
        if analysis.interactive_elements:
            best = max(analysis.interactive_elements, key=lambda e: e.confidence)
            return {
                "type": "tap",
                "nx": best.nx,
                "ny": best.ny,
                "params": {},
                "reasoning": f"[Tutorial] Follow instruction: {analysis.tutorial_instruction[:60]}",
            }
        return {
            "type": analysis.suggested_action_type,
            "nx": analysis.suggested_nx,
            "ny": analysis.suggested_ny,
            "params": analysis.suggested_params,
            "reasoning": f"[Tutorial] {analysis.suggested_reasoning}",
        }

    def _exploration_action(self, analysis: ScreenAnalysis) -> dict:
        """
        Pick a random interactive element to explore, or nudge the
        vision-suggested coordinates slightly to discover adjacent elements.
        """
        if analysis.interactive_elements:
            chosen = random.choice(analysis.interactive_elements)
            return {
                "type": "tap",
                "nx": chosen.nx,
                "ny": chosen.ny,
                "params": {},
                "reasoning": f"[Explore] Trying element: {chosen.label}",
            }
        # Gaussian jitter around the suggested point
        nx = min(0.95, max(0.05, analysis.suggested_nx + random.gauss(0, 0.1)))
        ny = min(0.95, max(0.05, analysis.suggested_ny + random.gauss(0, 0.1)))
        return {
            "type": "tap",
            "nx": nx,
            "ny": ny,
            "params": {},
            "reasoning": "[Explore] Jittered tap for discovery",
        }

    # ── Stuck recovery ────────────────────────────────────────────────────────

    def _recover(self, screen: ScreenState, analysis: ScreenAnalysis) -> bool:
        """
        Execute a sequence of recovery actions proposed by the LearningEngine.
        Returns True if at least one action produced a visible change.
        """
        recovery_actions = self._learner.build_recovery_plan(analysis)
        self._executor.reset_no_change_counter()
        made_progress = False

        for action in recovery_actions:
            current_screen = self._ctrl.capture_screen()
            result = self._executor.execute(action, current_screen, analysis)
            if result.outcome in (OUTCOME_SUCCESS, OUTCOME_PROGRESS):
                made_progress = True
                break
            time.sleep(1.0)

        return made_progress

    # ── Game completion detection ─────────────────────────────────────────────

    def _is_game_complete(
        self, screen: ScreenState, analysis: ScreenAnalysis
    ) -> bool:
        """
        Heuristic: game is "complete" when either:
          - The screen has been identical for many consecutive cycles, AND
          - We are stuck (recovery exhausted), OR
          - The analysis objective suggests there is nothing left to do.
        """
        nothing_to_do_phrases = [
            "nothing to do", "no more levels", "game complete",
            "fully upgraded", "max level", "all content cleared",
        ]
        obj_lower = analysis.objective.lower()
        if any(phrase in obj_lower for phrase in nothing_to_do_phrases):
            return True

        if self._prev_screen is not None:
            if self._analyzer.is_same_screen(self._prev_screen, screen):
                self._same_screen_count += 1
            else:
                self._same_screen_count = 0

        if self._same_screen_count >= _GAME_COMPLETE_THRESHOLD:
            return True

        return False

    # ── Context builder ───────────────────────────────────────────────────────

    def _build_perception_context(self) -> str:
        """
        Assemble a compact text context to include in vision analysis calls.
        Helps Claude make decisions that are consistent with history.
        """
        parts = [
            "=== RECENT ACTIONS ===",
            self._memory.recent_actions_summary(10),
            "",
            "=== GAME KNOWLEDGE ===",
            self._memory.knowledge_summary(20),
            "",
            "=== ACHIEVEMENTS ===",
            self._memory.achievements_summary(),
        ]
        return "\n".join(parts)

    # ── Shutdown ──────────────────────────────────────────────────────────────

    def _shutdown(self) -> None:
        self._running = False
        total = self._memory.action_count()
        achievements = self._memory.get_achievements()
        notes = (
            f"Session ended. Total actions: {total}. "
            f"Achievements: {len(achievements)}."
        )
        self._memory.end_session(self._session_id, notes)

        log.info("=" * 60)
        log.info("Session complete. Total actions: %d", total)
        log.info("Achievements earned:")
        for ach in achievements:
            log.info("  ✓ %s – %s", ach.title, ach.description)
        log.info("=" * 60)
