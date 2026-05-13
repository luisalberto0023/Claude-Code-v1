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
private const val SCREENSHOT_INTERVAL_MS  = 2_000L
private const val SAME_SCREEN_STOP        = 30
private const val MAX_RECOVERY_ATTEMPTS   = 5
private const val MAX_SESSION_ACTIONS     = 5_000

/**
 * Top-level orchestrator — the full perceive → plan → decide → act → evaluate → learn loop.
 *
 * Architecture after integrating SIMA-2 insights:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  SLOW LOOP (every ~12 fast steps) — HierarchicalPlanner            │
 *  │    claude-opus-4-7  →  high-level goal + updated memory summary    │
 *  │    RewardModel scores the previous goal                            │
 *  │    Self-task generation when goal is complete                      │
 *  ├─────────────────────────────────────────────────────────────────────┤
 *  │  FAST LOOP (every ~2 seconds) — VisionAnalyzer + SkillsLibrary     │
 *  │    claude-sonnet-4-6  →  single concrete action                    │
 *  │    Priority: tutorial → skill → strategy → vision suggestion       │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  RecurrentMemory  — rolling text summary passed to every LLM call
 *  LearningEngine   — periodic reflection + tutorial extraction
 *  SkillsLibrary    — pre-seeded + learned reusable atomic skills
 */
class GameAgent(
    private val screenCapture: ScreenCaptureService,
    private val accessibility: GameBotAccessibilityService,
    private val visionAnalyzer: VisionAnalyzer,
    private val memory: MemoryRepository,
    private val onStatusUpdate: (String) -> Unit = {},
    private val onComplete: () -> Unit = {},
    private val explorationRate: Float = 0.12f,
) {
    private val executor   = ActionExecutor(accessibility, screenCapture, visionAnalyzer)
    private val learner    = LearningEngine(memory, memory.getApiKeySync())
    private val planner    = HierarchicalPlanner(memory.getApiKeySync())
    private val skills     = SkillsLibrary(memory)
    private val recMem     = RecurrentMemory()

    private var sameScreenCount  = 0
    private var prevImageBase64  = ""
    private var recoveryAttempts = 0
    private var running          = false
    private var stepCount        = 0

    // ── Entry point ───────────────────────────────────────────────────────────

    suspend fun run() {
        running = true
        memory.startSession()
        skills.bootstrap()
        recMem.reset()

        // Initial slow-loop planning before any action
        val initScreen = screenCapture.captureBase64()
        if (initScreen != null) {
            planner.triggerSlowLoop(initScreen, "Session start", memory.knowledgeSummary(15))
            recMem.update(planner.rollingSummary)
            recMem.currentGoal = planner.currentGoal
        }

        while (running && memory.actionCount() < MAX_SESSION_ACTIONS) {
            stepCount++

            // ── 1. PERCEIVE ──────────────────────────────────────────────────
            val imageBase64 = screenCapture.captureBase64() ?: run { delay(500); continue }

            // Build rich context from recurrent memory + DB
            val context = buildString {
                append(recMem.toPromptContext())
                append("\n=== CURRENT HIGH-LEVEL GOAL ===\n")
                append(planner.currentGoal)
                append("\n\n=== RECENT ACTIONS ===\n")
                append(memory.recentActionsSummary(8))
            }

            val analysis = visionAnalyzer.analyse(imageBase64, context)
            val statusLine = "[${memory.actionCount()}] ${analysis.screenType}: ${analysis.objective.take(55)}"
            onStatusUpdate(statusLine)
            Log.i(TAG, statusLine)

            // ── 2. SLOW PLANNING TICK (updates goal + memory summary) ────────
            val highLevelGoal = planner.tick(
                imageBase64,
                memory.recentActionsSummary(10),
                memory.knowledgeSummary(15),
            )
            recMem.update(planner.rollingSummary)
            recMem.currentGoal    = planner.currentGoal
            recMem.lastNarration  = planner.currentNarration

            // ── 3. TUTORIAL KNOWLEDGE EXTRACTION ────────────────────────────
            if (analysis.screenType == "tutorial") learner.extractTutorialKnowledge(analysis)

            // ── 4. GAME-COMPLETE CHECK ────────────────────────────────────────
            if (isGameComplete(imageBase64, analysis)) {
                Log.i(TAG, "Game appears complete – stopping")
                onStatusUpdate("Game complete!")
                recMem.addHighlight("Game completed after ${memory.actionCount()} actions")
                break
            }

            // ── 5. STUCK CHECK + RECOVERY ────────────────────────────────────
            if (memory.isStuck()) {
                Log.w(TAG, "STUCK – attempt ${recoveryAttempts + 1}")
                onStatusUpdate("Stuck… trying recovery plan")
                val recovered = recover(imageBase64, analysis)
                if (!recovered) {
                    recoveryAttempts++
                    if (recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
                        Log.i(TAG, "Cannot progress – stopping")
                        onStatusUpdate("Cannot progress further")
                        break
                    }
                } else {
                    recoveryAttempts = 0
                }
                continue
            }

            // ── 6. DECIDE ACTION (fast loop) ──────────────────────────────────
            val action = decide(analysis, highLevelGoal)

            // ── 7. ACT ────────────────────────────────────────────────────────
            val result = executor.execute(
                type        = action["type"] ?: "tap",
                nx          = action["nx"]?.toFloatOrNull() ?: 0.5f,
                ny          = action["ny"]?.toFloatOrNull() ?: 0.5f,
                params      = action.filter { it.key !in listOf("type","nx","ny","reasoning") },
                imageBefore = imageBase64,
            )

            // ── 8. LOG ACTION ─────────────────────────────────────────────────
            memory.logAction(ActionEntity(
                screenType = analysis.screenType,
                actionType = result.actionType,
                nx         = result.nx,
                ny         = result.ny,
                reasoning  = action["reasoning"] ?: "",
                outcome    = result.outcome.name.lowercase(),
            ))

            // ── 9. DETECT ACHIEVEMENTS ────────────────────────────────────────
            if (result.imageAfterBase64 != null) {
                val post = visionAnalyzer.analyse(result.imageAfterBase64)
                detectAchievements(analysis, post)

                // Score goal completion every ~50 actions
                if (stepCount % 50 == 0) {
                    val score = planner.scoreGoalAttempt(
                        highLevelGoal, result.imageAfterBase64,
                        memory.recentActionsSummary(20),
                    )
                    recMem.recordGoalScore(highLevelGoal, score)
                    // If goal well-achieved, generate a fresh self-improvement task
                    if (score >= 7f) {
                        val nextTask = planner.generateNextTask(
                            result.imageAfterBase64,
                            memory.achievementsSummary(),
                            memory.knowledgeSummary(15),
                        )
                        recMem.addHighlight("New self-task: $nextTask")
                        Log.i(TAG, "Self-generated next task: $nextTask")
                    }
                }
            }

            // ── 10. PERIODIC DEEP REFLECTION ─────────────────────────────────
            if (learner.shouldReflect()) {
                onStatusUpdate("Reflecting on what I've learned…")
                val summary = learner.reflect(analysis)
                if (summary.isNotBlank()) recMem.addHighlight("Reflection: $summary")
            }

            prevImageBase64 = imageBase64
            delay(SCREENSHOT_INTERVAL_MS / 2)
        }

        memory.endSession()
        onComplete()
    }

    fun stop() { running = false }

    // ── Decision making (fast loop) ───────────────────────────────────────────

    /**
     * Priority chain:
     *   1. Tutorial mode  → follow on-screen instruction
     *   2. Skill match    → use pre-seeded / learned atomic skill
     *   3. Known strategy → highest success-rate strategy for this screen
     *   4. Vision model   → claude-sonnet-4-6 suggestion (default)
     *   5. Exploration    → random element from detected interactive list
     */
    private fun decide(analysis: ScreenAnalysis, highLevelGoal: String): Map<String, String> {

        // 1. Tutorial
        if (analysis.screenType == "tutorial") return decideTutorial(analysis)

        // 2. Skill match from SkillsLibrary
        val skill = skills.suggestSkill(analysis.screenType, analysis.objective, analysis.blockingIssues)
        if (skill != null) {
            Log.d(TAG, "SKILL match: ${skill.situation}")
            return mapOf(
                "type"      to skill.actionType,
                "nx"        to skill.nx.toString(),
                "ny"        to skill.ny.toString(),
                "reasoning" to "[Skill] ${skill.description}",
            )
        }

        // 3. High-confidence learned strategy
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

        // 4. Vision-suggested action (default fast loop)
        val sa = analysis.suggestedAction
        val base = mapOf(
            "type"      to sa.type,
            "nx"        to sa.nx.toString(),
            "ny"        to sa.ny.toString(),
            "reasoning" to sa.reasoning,
        ) + sa.params

        // 5. Exploration jitter
        if (Random.nextFloat() < explorationRate && analysis.interactiveElements.isNotEmpty()) {
            val el = analysis.interactiveElements.random()
            return mapOf(
                "type"      to "tap",
                "nx"        to el.nx.toString(),
                "ny"        to el.ny.toString(),
                "reasoning" to "[Explore] ${el.label}",
            )
        }

        return base
    }

    private fun decideTutorial(analysis: ScreenAnalysis): Map<String, String> {
        val best = analysis.interactiveElements.maxByOrNull { it.confidence }
        val sa   = analysis.suggestedAction
        return if (best != null) mapOf(
            "type" to "tap", "nx" to best.nx.toString(), "ny" to best.ny.toString(),
            "reasoning" to "[Tutorial] ${analysis.tutorialInstruction.take(60)}",
        ) else mapOf(
            "type" to sa.type, "nx" to sa.nx.toString(), "ny" to sa.ny.toString(),
            "reasoning" to "[Tutorial] ${sa.reasoning}",
        )
    }

    // ── Recovery ──────────────────────────────────────────────────────────────

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
            if (result.outcome == Outcome.SUCCESS || result.outcome == Outcome.PROGRESS) return true
            delay(1_000L)
        }
        return false
    }

    // ── Achievement detection ─────────────────────────────────────────────────

    private fun detectAchievements(before: ScreenAnalysis, after: ScreenAnalysis) {
        val count = memory.actionCount()
        if (before.screenType == "tutorial" && after.screenType != "tutorial") {
            memory.recordAchievement(AchievementEntity(
                title = "Tutorial Completed", description = "Moved to ${after.screenType}",
                screenType = after.screenType, actionCount = count,
            ))
            recMem.addHighlight("Tutorial completed!")
        }
        if (after.screenType == "victory") {
            val level = after.gameState.level ?: before.gameState.level
            memory.recordAchievement(AchievementEntity(
                title = if (level != null) "Level $level Cleared" else "Level Cleared",
                description = after.objective, screenType = "victory", actionCount = count,
            ))
            recMem.addHighlight("Level ${level ?: "?"} cleared!")
        }
        listOf("level" to after.gameState.level, "score" to after.gameState.score?.toInt()).forEach { (key, newVal) ->
            val oldVal = when (key) {
                "level" -> before.gameState.level
                else    -> before.gameState.score?.toInt()
            }
            if (oldVal != null && newVal != null && newVal > oldVal) {
                memory.recordAchievement(AchievementEntity(
                    title = "${key.replaceFirstChar { it.uppercase() }} Increased",
                    description = "$key: $oldVal → $newVal",
                    screenType = after.screenType, actionCount = count,
                ))
            }
        }
    }

    // ── Game-complete detection ───────────────────────────────────────────────

    private suspend fun isGameComplete(imageBase64: String, analysis: ScreenAnalysis): Boolean {
        val done = listOf(
            "nothing to do", "no more levels", "game complete",
            "max level", "fully upgraded", "all content cleared",
        ).any { it in analysis.objective.lowercase() }
        if (done) return true
        if (prevImageBase64.isNotEmpty()) {
            if (visionAnalyzer.isSameScreen(prevImageBase64, imageBase64)) sameScreenCount++
            else sameScreenCount = 0
        }
        return sameScreenCount >= SAME_SCREEN_STOP
    }

    // ── Expose recurrent memory for UI ────────────────────────────────────────

    fun getRecurrentMemory(): RecurrentMemory = recMem

    private suspend fun MemoryRepository.knowledgeSummary(n: Int): String = buildString {
        val items = try {
            val field = this@knowledgeSummary::class.java.getDeclaredMethod("knowledgeSummary", Int::class.java)
            field.invoke(this@knowledgeSummary, n) as? String ?: ""
        } catch (e: Exception) { "" }
        append(items)
    }

    private suspend fun MemoryRepository.achievementsSummary(): String = runCatching {
        val m = this::class.java.getDeclaredMethod("achievementsSummary")
        m.invoke(this) as? String ?: ""
    }.getOrDefault("")
}
