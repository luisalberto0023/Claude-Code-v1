package com.gamebot.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityEvent
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * The component that replaces ADB on a standalone device.
 *
 * Android's AccessibilityService can inject arbitrary touch gestures into any
 * foreground application via GestureDescription + dispatchGesture().  No root,
 * no USB cable, no computer required.  The user enables this once in:
 *   Settings → Accessibility → Downloaded apps → GameBot → Enable
 *
 * All coordinates are in PIXELS (the device's physical screen coordinates).
 * The agent works in normalised [0,1] space; [ActionExecutor] converts before
 * calling this service.
 */
class GameBotAccessibilityService : AccessibilityService() {

    companion object {
        /** Singleton set when the OS binds the service (after user enables it). */
        @Volatile
        var instance: GameBotAccessibilityService? = null
            private set

        val isEnabled: Boolean get() = instance != null
    }

    var screenWidth  = 0; private set
    var screenHeight = 0; private set

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onServiceConnected() {
        instance = this
        val metrics: DisplayMetrics = resources.displayMetrics
        screenWidth  = metrics.widthPixels
        screenHeight = metrics.heightPixels
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        // We only use this service for gesture injection, not for reading UI hierarchy.
        // The game UI is captured via screenshot (MediaProjection) and analysed by Claude.
    }

    override fun onInterrupt() {}

    // ── Gesture API ───────────────────────────────────────────────────────────

    /**
     * Tap at pixel coordinates (x, y).
     * Suspends until the gesture is dispatched (or fails).
     */
    suspend fun tap(x: Float, y: Float): Boolean = dispatchPath(
        Path().apply { moveTo(x, y) }, durationMs = 50L
    )

    /** Long-press: same position, longer hold. */
    suspend fun longPress(x: Float, y: Float, durationMs: Long = 800L): Boolean =
        dispatchPath(Path().apply { moveTo(x, y) }, durationMs)

    /** Swipe from (fromX,fromY) to (toX,toY) over [durationMs] ms. */
    suspend fun swipe(
        fromX: Float, fromY: Float,
        toX: Float,   toY: Float,
        durationMs: Long = 300L,
    ): Boolean = dispatchPath(
        Path().apply {
            moveTo(fromX, fromY)
            lineTo(toX, toY)
        },
        durationMs,
    )

    /**
     * Two-finger pinch gesture.
     * Requires dispatching two strokes simultaneously.
     */
    suspend fun pinch(
        centerX: Float, centerY: Float,
        startSpreadPx: Float, endSpreadPx: Float,
        durationMs: Long = 400L,
    ): Boolean {
        val path1 = Path().apply {
            moveTo(centerX - startSpreadPx, centerY)
            lineTo(centerX - endSpreadPx,   centerY)
        }
        val path2 = Path().apply {
            moveTo(centerX + startSpreadPx, centerY)
            lineTo(centerX + endSpreadPx,   centerY)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path1, 0, durationMs))
            .addStroke(GestureDescription.StrokeDescription(path2, 0, durationMs))
            .build()
        return dispatchGestureSuspend(gesture)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private suspend fun dispatchPath(path: Path, durationMs: Long): Boolean {
        val stroke  = GestureDescription.StrokeDescription(path, 0, durationMs)
        val gesture = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGestureSuspend(gesture)
    }

    private suspend fun dispatchGestureSuspend(gesture: GestureDescription): Boolean =
        suspendCancellableCoroutine { cont ->
            val dispatched = dispatchGesture(
                gesture,
                object : GestureResultCallback() {
                    override fun onCompleted(g: GestureDescription) { cont.resume(true) }
                    override fun onCancelled(g: GestureDescription) { cont.resume(false) }
                },
                null,
            )
            if (!dispatched) cont.resume(false)
        }
}
