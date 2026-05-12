package com.gamebot.agent

import android.util.Log
import com.gamebot.service.GameBotAccessibilityService
import com.gamebot.service.ScreenCaptureService
import kotlinx.coroutines.delay

private const val TAG = "ActionExecutor"

/** Outcome of an executed action. */
enum class Outcome { SUCCESS, FAILURE, NO_CHANGE, PROGRESS }

data class ExecutionResult(
    val actionType: String,
    val nx: Float,
    val ny: Float,
    val outcome: Outcome,
    val imageAfterBase64: String?,
)

/**
 * Translates high-level action commands into device gestures via
 * [GameBotAccessibilityService], then classifies the outcome by comparing
 * the screen before and after.
 *
 * All coordinates are normalised [0,1]; this class multiplies to pixels.
 */
class ActionExecutor(
    private val accessibility: GameBotAccessibilityService,
    private val screenCapture: ScreenCaptureService,
    private val visionAnalyzer: VisionAnalyzer,
    private val actionDelayMs: Long = 800L,
) {
    var consecutiveNoChange = 0
        private set

    // ── Execute ───────────────────────────────────────────────────────────────

    suspend fun execute(
        type: String,
        nx: Float,
        ny: Float,
        params: Map<String, String> = emptyMap(),
        imageBefore: String? = null,
    ): ExecutionResult {
        Log.i(TAG, "ACTION  %-14s  @ (%.3f, %.3f)".format(type, nx, ny))

        dispatch(type, nx, ny, params)
        delay(actionDelayMs)

        val imageAfter = screenCapture.captureBase64()

        val outcome = when {
            imageBefore == null || imageAfter == null -> Outcome.SUCCESS
            imageBefore == imageAfter                 -> Outcome.NO_CHANGE
            else -> classifyOutcome(imageBefore, imageAfter)
        }

        if (outcome == Outcome.NO_CHANGE) consecutiveNoChange++
        else                              consecutiveNoChange = 0

        Log.i(TAG, "OUTCOME $outcome  (streak=${consecutiveNoChange})")
        return ExecutionResult(type, nx, ny, outcome, imageAfter)
    }

    fun resetNoChangeCounter() { consecutiveNoChange = 0 }

    // ── Dispatch table ────────────────────────────────────────────────────────

    private suspend fun dispatch(type: String, nx: Float, ny: Float, params: Map<String, String>) {
        val w = accessibility.screenWidth.toFloat()
        val h = accessibility.screenHeight.toFloat()
        val px = nx * w
        val py = ny * h

        when (type) {
            "tap"         -> accessibility.tap(px, py)
            "long_press"  -> accessibility.longPress(px, py,
                                params["duration_ms"]?.toLongOrNull() ?: 800L)
            "swipe"       -> {
                val tx = (params["to_nx"]?.toFloatOrNull() ?: nx) * w
                val ty = (params["to_ny"]?.toFloatOrNull() ?: (ny + 0.3f)) * h
                val dur = params["duration_ms"]?.toLongOrNull() ?: 300L
                accessibility.swipe(px, py, tx, ty, dur)
            }
            "scroll_down" -> {
                val dist = params["distance"]?.toFloatOrNull() ?: 0.3f
                accessibility.swipe(px, py, px, py - dist * h, 400L)
            }
            "scroll_up" -> {
                val dist = params["distance"]?.toFloatOrNull() ?: 0.3f
                accessibility.swipe(px, py, px, py + dist * h, 400L)
            }
            "pinch_in"  -> accessibility.pinch(px, py, w * 0.2f, w * 0.05f)
            "pinch_out" -> accessibility.pinch(px, py, w * 0.05f, w * 0.2f)
            "back"      -> accessibility.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
            "home"      -> accessibility.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME)
            "wait"      -> delay((params["seconds"]?.toFloatOrNull() ?: 2f).toLong() * 1000L)
            else        -> { Log.w(TAG, "Unknown action '$type', defaulting to tap"); accessibility.tap(px, py) }
        }
    }

    // ── Outcome classification ────────────────────────────────────────────────

    private suspend fun classifyOutcome(before: String, after: String): Outcome {
        // Fast: compare a sample of base64 bytes
        val similarity = sampleSimilarity(before, after)
        return when {
            similarity > 0.995 -> Outcome.NO_CHANGE
            similarity < 0.90  -> Outcome.PROGRESS
            else -> {
                // Borderline – ask Claude
                if (visionAnalyzer.isSameScreen(before, after)) Outcome.NO_CHANGE
                else Outcome.SUCCESS
            }
        }
    }

    private fun sampleSimilarity(a: String, b: String): Float {
        val step = maxOf(1, a.length / 2000)
        var matches = 0; var total = 0
        var i = 0
        while (i < a.length && i < b.length) {
            if (a[i] == b[i]) matches++
            total++
            i += step
        }
        return if (total == 0) 1f else matches.toFloat() / total
    }
}
