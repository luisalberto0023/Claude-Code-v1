package com.gamebot.agent

import android.util.Log
import com.gamebot.data.db.ActionEntity
import com.gamebot.data.db.AchievementEntity
import com.gamebot.data.repository.MemoryRepository
import com.gamebot.model.ScreenAnalysis
import com.gamebot.service.GameBotAccessibilityService
import com.gamebot.service.ScreenCaptureService
import kotlinx.coroutines.delay
import kotlin.random.Random

private const val TAG = "GameAgent"
private const val SCREENSHOT_INTERVAL_MS = 2_000L
private const val SAME_SCREEN_STOP_THRESHOLD = 30
private const val MAX_RECOVERY_ATTEMPTS = 5
private const val MAX_SESSION_ACTIONS = 5_000

/**
 * Top-level orchestrator. Runs the core perceive → decide → act → evaluate → learn loop.
 *
 *   PERCEIVE   – take a screenshot, run VisionAnalyzer
 *   DECIDE     – pick the best action (tutorial > strategy memory > vision suggestion > explore)
 *   ACT        – dispatch via ActionExecutor
 *   EVALUATE   – classify outcome, detect achievements
 *   LEARN      – periodic reflection, extract tutorial knowledge
 *
 * Mirrors all the traits a human gamer has:
 *   • Follows tutorials step-by-step
 *   • Builds up a knowledge base of game mechanics
 *   • Remembers what worked and applies it
 *   • Explores when stuck instead of hammering the same button
 *   • Stops when it truly cannot progress
 */
class GameAgent(
    private val screenCapture: ScreenCaptureService,
    private val accessibility: GameBotAccessibilityService,
    private val visionAnalyzer: VisionAnalyzer,
    private val memory: MemoryRepository,
    private val onStatusUpdate: (String) -> Unit = {},
    private val onComplete: () -> Unit = {},
    private val explorationRate: Float = 0.15f,
) {
    private val executor = ActionExecutor(accessibility, screenCapture, visionAnalyzer)
    private val learner  = LearningEngine(memory, memory.getApiKeySync())

    private var sameScreenCount   = 0
    private var prevImageBase64   = ""
    private var recoveryAttempts  = 0
    private var running           = false

    // ── Entry point ───────────────────────────────────────────────────────────

    suspend fun run() {
        running = true
        memory.startSession()

        while (running && memory.actionCount() < MAX_SESSION_ACTIONS) {

            // ── 1. PERCEIVE ──────────────────────────────────────────────────
            val imageBase64 = screenCapture.captureBase64() ?: run {
                delay(500); continue
            }
            val context   = memory.buildContext()
            val analysis  = visionAnalyzer.analyse(imageBase64, context)

            onStatusUpdate("[${memory.actionCount()}] ${analysis.screenType}: ${analysis.objective.take(50)}")
            Log.i(TAG, "[${memory.actionCount()}] ${analysis.screenType} | ${analysis.objective}")

            // ── 2. EXTRACT TUTORIAL KNOWLEDGE ────────────────────────────────
            if (analysis.screenType == "tutorial") learner.extractTutorialKnowledge(analysis)

            // ── 3. GAME COMPLETE CHECK ────────────────────────────────────────
            if (isGameComplete(imageBase64, analysis)) {
                Log.i(TAG, "Game appears complete – stopping")
                onStatusUpdate("Game complete!")
                break
            }

            // ── 4. STUCK CHECK ────────────────────────────────────────────────
            if (memory.isStuck()) {
                Log.w(TAG, "Stuck – triggering recovery (attempt ${recoveryAttempts + 1})")
                val recovered = recover(imageBase64, analysis)
                if (!recovered) {
                    recoveryAttempts++
                    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                        Log.i(TAG, "Cannot progress after $MAX_RECOVERY_ATTEMPTS recovery attempts")
                        onStatusUpdate("No progress possible – stopping")
                        break
                    }
                } else {
                    recoveryAttempts = 0
                }
                continue
            }

            // ── 5. DECIDE ─────────────────────────────────────────────────────
            val action = decide(analysis)

            // ── 6. ACT ────────────────────────────────────────────────────────
            val result = executor.execute(
                type        = action["type"] ?: "tap",
                nx          = action["nx"]?.toFloatOrNull() ?: 0.5f,
                ny          = action["ny"]?.toFloatOrNull() ?: 0.5f,
                params      = action.filter { it.key !in listOf("type","nx","ny","reasoning") },
                imageBefore = imageBase64,
            )

            // ── 7. LOG ACTION ─────────────────────────────────────────────────
            memory.logAction(ActionEntity(
                screenType = analysis.screenType,
                actionType = result.actionType,
                nx         = result.nx,
                ny         = result.ny,
                reasoning  = action["reasoning"] ?: "",
                outcome    = result.outcome.name.lowercase(),
            ))

            // ── 8. DETECT ACHIEVEMENTS ────────────────────────────────────────
            if (result.imageAfterBase64 != null) {
                val postAnalysis = visionAnalyzer.analyse(result.imageAfterBase64)
                detectAchievements(analysis, postAnalysis)
            }

            // ── 9. PERIODIC REFLECTION ────────────────────────────────────────
            if (learner.shouldReflect()) {
                onStatusUpdate("Reflecting on what I've learned…")
                learner.reflect(analysis)
            }

            prevImageBase64 = imageBase64
            delay(SCREENSHOT_INTERVAL_MS / 2)
        }

        memory.endSession()
        onComplete()
    }

    fun stop() { running = false }

    // ── Decision making ───────────────────────────────────────────────────────

    private fun decide(analysis: ScreenAnalysis): Map<String, String> {
        // Priority 1: tutorials – always follow the on-screen instruction
        if (analysis.screenType == "tutorial") return decideTutorial(analysis)

        // Priority 2: known high-confidence strategy
        val strategy = memory.getBestStrategy(analysis.screenType)
        if (strategy != null && strategy.successCount >= 2 &&
            strategy.successRate > 0.5f && Random.nextFloat() > explorationRate) {
            return mapOf(
                "type"      to strategy.actionType,
                "nx"        to strategy.nx.toString(),
                "ny"        to strategy.ny.toString(),
                "reasoning" to "[Strategy] ${strategy.description}",
            )
        }

        // Priority 3: exploration – try a random interactive element
        if (Random.nextFloat() < explorationRate && analysis.interactiveElements.isNotEmpty()) {
            val el = analysis.interactiveElements.random()
            return mapOf(
                "type"      to "tap",
                "nx"        to el.nx.toString(),
                "ny"        to el.ny.toString(),
                "reasoning" to "[Explore] ${el.label}",
            )
        }

        // Priority 4: vision-suggested action (default)
        val sa = analysis.suggestedAction
        return mapOf(
            "type"      to sa.type,
            "nx"        to sa.nx.toString(),
            "ny"        to sa.ny.toString(),
            "reasoning" to sa.reasoning,
        ) + sa.params
    }

    private fun decideTutorial(analysis: ScreenAnalysis): Map<String, String> {
        val best = analysis.interactiveElements.maxByOrNull { it.confidence }
        return if (best != null) {
            mapOf(
                "type"      to "tap",
                "nx"        to best.nx.toString(),
                "ny"        to best.ny.toString(),
                "reasoning" to "[Tutorial] ${analysis.tutorialInstruction.take(60)}",
            )
        } else {
            val sa = analysis.suggestedAction
            mapOf(
                "type"      to sa.type,
                "nx"        to sa.nx.toString(),
                "ny"        to sa.ny.toString(),
                "reasoning" to "[Tutorial] ${sa.reasoning}",
            )
        }
    }

    // ── Stuck recovery ────────────────────────────────────────────────────────

    private suspend fun recover(imageBase64: String, analysis: ScreenAnalysis): Boolean {
        executor.resetNoChangeCounter()
        val actions = learner.buildRecoveryPlan(analysis)

        for (action in actions) {
            val img = screenCapture.captureBase64() ?: continue
            val result = executor.execute(
                type  = action["type"] ?: "tap",
                nx    = action["nx"]?.toFloatOrNull() ?: 0.5f,
                ny    = action["ny"]?.toFloatOrNull() ?: 0.5f,
                imageBefore = img,
            )
            if (result.outcome == Outcome.SUCCESS || result.outcome == Outcome.PROGRESS) {
                return true
            }
            delay(1_000L)
        }
        return false
    }

    // ── Achievement detection ─────────────────────────────────────────────────

    private fun detectAchievements(before: ScreenAnalysis, after: ScreenAnalysis) {
        val count = memory.actionCount()

        if (before.screenType == "tutorial" && after.screenType != "tutorial") {
            memory.recordAchievement(AchievementEntity(
                title       = "Tutorial Completed",
                description = "Moved from tutorial to ${after.screenType}",
                screenType  = after.screenType,
                actionCount = count,
            ))
        }
        if (after.screenType == "victory") {
            val level = after.gameState.level ?: before.gameState.level
            memory.recordAchievement(AchievementEntity(
                title       = if (level != null) "Level $level Cleared" else "Level Cleared",
                description = after.objective,
                screenType  = "victory",
                actionCount = count,
            ))
        }
        listOf("level", "score", "stars").forEach { key ->
            val oldVal = when (key) {
                "level" -> before.gameState.level?.toFloat()
                "score" -> before.gameState.score?.toFloat()
                else    -> before.progressIndicators.stars?.toFloat()
            }
            val newVal = when (key) {
                "level" -> after.gameState.level?.toFloat()
                "score" -> after.gameState.score?.toFloat()
                else    -> after.progressIndicators.stars?.toFloat()
            }
            if (oldVal != null && newVal != null && newVal > oldVal) {
                memory.recordAchievement(AchievementEntity(
                    title       = "${key.replaceFirstChar { it.uppercase() }} Increased",
                    description = "$key: $oldVal → $newVal",
                    screenType  = after.screenType,
                    actionCount = count,
                ))
            }
        }
    }

    // ── Game complete detection ───────────────────────────────────────────────

    private suspend fun isGameComplete(imageBase64: String, analysis: ScreenAnalysis): Boolean {
        val noMoreContent = listOf(
            "nothing to do", "no more levels", "game complete",
            "max level", "fully upgraded", "all content cleared",
        ).any { it in analysis.objective.lowercase() }
        if (noMoreContent) return true

        if (prevImageBase64.isNotEmpty()) {
            if (visionAnalyzer.isSameScreen(prevImageBase64, imageBase64)) sameScreenCount++
            else sameScreenCount = 0
        }
        return sameScreenCount >= SAME_SCREEN_STOP_THRESHOLD
    }
}
