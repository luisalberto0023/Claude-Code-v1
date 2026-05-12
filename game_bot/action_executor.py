"""
Action executor – translates high-level action decisions into device interactions.

Responsibilities:
  - Accept an action dict from the agent/vision layer
  - Call the correct MobileController method
  - Detect whether the action had a visible effect (outcome classification)
  - Handle retries for transient failures
  - Log every action to memory
"""

import logging
import time
from dataclasses import dataclass
from typing import Any, Optional

from .config import config
from .memory_system import ActionRecord, MemorySystem
from .mobile_controller import MobileController, ScreenState
from .vision_analyzer import ScreenAnalysis, VisionAnalyzer

log = logging.getLogger(__name__)

# Outcome labels stored in memory
OUTCOME_SUCCESS   = "success"
OUTCOME_FAILURE   = "failure"
OUTCOME_NO_CHANGE = "no_change"
OUTCOME_PROGRESS  = "progress"


@dataclass
class ExecutionResult:
    action_type: str
    nx: float
    ny: float
    outcome: str
    screen_before: ScreenState
    screen_after: ScreenState
    analysis_after: Optional[ScreenAnalysis]
    action_id: int   # ID in the action_history table


class ActionExecutor:
    """
    Executes actions on the device and classifies their outcomes.
    """

    def __init__(
        self,
        controller: MobileController,
        analyzer: VisionAnalyzer,
        memory: MemorySystem,
    ):
        self._ctrl = controller
        self._analyzer = analyzer
        self._memory = memory
        self._consecutive_no_change = 0

    # ── Main entry point ──────────────────────────────────────────────────────

    def execute(
        self,
        action: dict[str, Any],
        screen_before: ScreenState,
        analysis_before: ScreenAnalysis,
    ) -> ExecutionResult:
        """
        Execute one action and return its result.

        `action` must have keys: type, nx, ny, params, reasoning
        """
        action_type = action.get("type", "tap")
        nx = float(action.get("nx", 0.5))
        ny = float(action.get("ny", 0.5))
        params = action.get("params", {})
        reasoning = action.get("reasoning", "")

        log.info(
            "ACTION  %-15s  @ (%.3f, %.3f)  %s",
            action_type, nx, ny, reasoning[:60],
        )

        # Dispatch
        self._dispatch(action_type, nx, ny, params)

        # Capture result
        screen_after = self._ctrl.capture_screen()
        analysis_after = None

        # Classify outcome
        outcome = self._classify_outcome(
            screen_before, screen_after, analysis_before
        )

        if outcome == OUTCOME_NO_CHANGE:
            self._consecutive_no_change += 1
        else:
            self._consecutive_no_change = 0

        # Persist
        record = ActionRecord(
            screen_type=analysis_before.screen_type,
            action_type=action_type,
            nx=nx,
            ny=ny,
            params=params,
            reasoning=reasoning,
            outcome=outcome,
            screenshot_path=screen_after.image_path,
        )
        action_id = self._memory.log_action(record)

        log.info("OUTCOME %s  (consecutive_no_change=%d)", outcome, self._consecutive_no_change)
        return ExecutionResult(
            action_type=action_type,
            nx=nx,
            ny=ny,
            outcome=outcome,
            screen_before=screen_before,
            screen_after=screen_after,
            analysis_after=analysis_after,
            action_id=action_id,
        )

    def execute_with_retry(
        self,
        action: dict[str, Any],
        screen_before: ScreenState,
        analysis_before: ScreenAnalysis,
        max_retries: int = 2,
    ) -> ExecutionResult:
        """Execute, retrying on failure up to max_retries times."""
        result = self.execute(action, screen_before, analysis_before)
        attempts = 1

        while result.outcome == OUTCOME_FAILURE and attempts <= max_retries:
            log.warning("Action failed, retry %d/%d", attempts, max_retries)
            time.sleep(1.0 * attempts)
            screen_before = result.screen_after
            result = self.execute(action, screen_before, analysis_before)
            attempts += 1

        return result

    @property
    def consecutive_no_change(self) -> int:
        return self._consecutive_no_change

    def reset_no_change_counter(self) -> None:
        self._consecutive_no_change = 0

    # ── Dispatch table ────────────────────────────────────────────────────────

    def _dispatch(
        self, action_type: str, nx: float, ny: float, params: dict
    ) -> None:
        match action_type:
            case "tap":
                self._ctrl.tap(nx, ny)

            case "long_press":
                self._ctrl.long_press(nx, ny)

            case "swipe":
                tx = float(params.get("to_nx", nx))
                ty = float(params.get("to_ny", ny + 0.3))
                dur = int(params.get("duration_ms", 300))
                self._ctrl.swipe(nx, ny, tx, ty, dur)

            case "scroll_down":
                dist = float(params.get("distance", 0.3))
                self._ctrl.scroll_down(nx, dist)

            case "scroll_up":
                dist = float(params.get("distance", 0.3))
                self._ctrl.scroll_up(nx, dist)

            case "pinch_in":
                self._ctrl.pinch_in(nx, ny)

            case "pinch_out":
                self._ctrl.pinch_out(nx, ny)

            case "back":
                self._ctrl.press_back()

            case "home":
                self._ctrl.press_home()

            case "text_input":
                text = str(params.get("text", ""))
                self._ctrl.type_text(text)

            case "wait":
                seconds = float(params.get("seconds", 2.0))
                log.debug("Waiting %.1fs", seconds)
                time.sleep(seconds)

            case _:
                log.warning("Unknown action type %r – defaulting to tap", action_type)
                self._ctrl.tap(nx, ny)

    # ── Outcome classification ────────────────────────────────────────────────

    def _classify_outcome(
        self,
        before: ScreenState,
        after: ScreenState,
        analysis_before: ScreenAnalysis,
    ) -> str:
        """
        Decide whether the action caused a meaningful change.
        Uses a fast pixel-similarity heuristic first; only calls Claude when
        the heuristic is inconclusive.
        """
        # Quick byte-level diff heuristic
        if before.image_base64 == after.image_base64:
            return OUTCOME_NO_CHANGE

        # Compare a few bytes to detect trivial animation-only changes
        similarity = self._byte_similarity(before.image_base64, after.image_base64)

        if similarity > 0.995:
            # Nearly identical – probably just an animation frame
            return OUTCOME_NO_CHANGE

        if similarity < 0.90:
            # Significant change – likely meaningful progress
            return OUTCOME_PROGRESS

        # Borderline – use Claude to decide
        try:
            same = self._analyzer.is_same_screen(before, after)
            if same:
                return OUTCOME_NO_CHANGE
            # Changed but not dramatically – call it success
            return OUTCOME_SUCCESS
        except Exception:
            # If vision call fails, conservatively say success
            return OUTCOME_SUCCESS

    @staticmethod
    def _byte_similarity(b64_a: str, b64_b: str) -> float:
        """
        Rough pixel similarity: compare sampled bytes of the base64 strings.
        Much faster than decoding full PNGs.
        """
        step = max(1, len(b64_a) // 2000)
        sample_a = b64_a[::step]
        sample_b = b64_b[::step]
        length = min(len(sample_a), len(sample_b))
        if length == 0:
            return 1.0
        matches = sum(ca == cb for ca, cb in zip(sample_a[:length], sample_b[:length]))
        return matches / length
