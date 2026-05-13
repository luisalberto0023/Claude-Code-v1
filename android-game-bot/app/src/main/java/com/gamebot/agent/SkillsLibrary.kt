package com.gamebot.agent

import android.util.Log
import com.gamebot.data.db.StrategyEntity
import com.gamebot.data.repository.MemoryRepository

private const val TAG = "SkillsLibrary"

/**
 * Reusable cross-game atomic skills, inspired by SIMA-2.
 *
 * SIMA-2 insight:
 *   "SIMA 2 learns reusable skills like 'walk to point', 'interact with object',
 *    and 'aim at target' that work across games with similar control schemes."
 *
 * In mobile games the equivalent primitives are:
 *   - navigate_to(element_label)   → tap the named element
 *   - dismiss_dialog()             → tap the positive/confirm button
 *   - scroll_for(target_label)     → scroll until target appears
 *   - drag(from, to)               → drag between two coordinates
 *   - long_press_for_context()     → long-press to open context menu
 *   - collect_resource()           → tap on loose resource nodes
 *   - enter_text(value)            → tap field, clear, type
 *
 * Skills are stored in the strategy database with situation keys prefixed
 * "skill:" so they can be looked up by name across all games.
 *
 * The library bootstraps with built-in skills (hand-coded, high confidence)
 * and grows as the LearningEngine extracts new ones from experience.
 */
class SkillsLibrary(private val memory: MemoryRepository) {

    // ── Built-in skills ───────────────────────────────────────────────────────

    private val builtInSkills: List<StrategyEntity> = listOf(
        // Dismiss any standard dialog by tapping the bottom-right area (OK/Confirm)
        StrategyEntity(
            situation    = "skill:dismiss_dialog",
            actionType   = "tap",
            nx           = 0.75f, ny = 0.75f,
            description  = "Dismiss dialog – tap lower-right confirm area",
            successCount = 5,
        ),
        // Collect resource nodes that typically appear in the play area centre
        StrategyEntity(
            situation    = "skill:collect_resource",
            actionType   = "tap",
            nx           = 0.5f, ny = 0.5f,
            description  = "Collect loose resource by tapping centre",
            successCount = 3,
        ),
        // Skip/close tutorial overlays: X button top-right
        StrategyEntity(
            situation    = "skill:skip_tutorial",
            actionType   = "tap",
            nx           = 0.92f, ny = 0.08f,
            description  = "Skip tutorial – tap top-right close button",
            successCount = 3,
        ),
        // Navigate to menu: tap hamburger top-left
        StrategyEntity(
            situation    = "skill:open_menu",
            actionType   = "tap",
            nx           = 0.08f, ny = 0.08f,
            description  = "Open main menu – tap top-left hamburger",
            successCount = 2,
        ),
        // Scroll down to find more content
        StrategyEntity(
            situation    = "skill:scroll_explore",
            actionType   = "scroll_down",
            nx           = 0.5f, ny = 0.5f,
            description  = "Scroll down to reveal hidden UI elements",
            successCount = 2,
        ),
        // Confirm purchase / next step
        StrategyEntity(
            situation    = "skill:confirm_action",
            actionType   = "tap",
            nx           = 0.5f, ny = 0.80f,
            description  = "Confirm primary action – tap bottom-centre button",
            successCount = 4,
        ),
        // Retry after game over
        StrategyEntity(
            situation    = "skill:retry_after_failure",
            actionType   = "tap",
            nx           = 0.5f, ny = 0.65f,
            description  = "Retry / Play Again – centre-lower area",
            successCount = 3,
        ),
        // Zoom out to see the full map
        StrategyEntity(
            situation    = "skill:zoom_out",
            actionType   = "pinch_in",
            nx           = 0.5f, ny = 0.5f,
            description  = "Pinch-in to zoom out and see more of the map",
            successCount = 2,
        ),
    )

    // ── Init ──────────────────────────────────────────────────────────────────

    fun bootstrap() {
        var seeded = 0
        for (skill in builtInSkills) {
            try {
                memory.upsertStrategy(skill)
                seeded++
            } catch (e: Exception) {
                Log.w(TAG, "Could not seed skill ${skill.situation}: ${e.message}")
            }
        }
        Log.i(TAG, "SkillsLibrary bootstrapped $seeded built-in skills")
    }

    // ── Lookup ────────────────────────────────────────────────────────────────

    fun getSkill(skillName: String): StrategyEntity? =
        memory.getBestStrategy("skill:$skillName")

    fun allSkills(): List<StrategyEntity> =
        builtInSkills.map { it.situation }
            .mapNotNull { memory.getBestStrategy(it) }

    /**
     * Given the current screen analysis text, suggest the best matching skill.
     * Uses simple keyword matching — no extra API call needed.
     */
    fun suggestSkill(screenType: String, objective: String, blockingIssues: List<String>): StrategyEntity? {
        val ctx = "$screenType $objective ${blockingIssues.joinToString()}".lowercase()

        return when {
            "dialog" in ctx || "popup" in ctx || "confirm" in ctx ->
                getSkill("dismiss_dialog")
            "game_over" in ctx || "failed" in ctx || "retry" in ctx ->
                getSkill("retry_after_failure")
            "tutorial" in ctx && ("skip" in ctx || "close" in ctx) ->
                getSkill("skip_tutorial")
            "menu" in ctx && "open" in ctx ->
                getSkill("open_menu")
            "resource" in ctx || "collect" in ctx || "pick" in ctx ->
                getSkill("collect_resource")
            "scroll" in ctx || "hidden" in ctx || "more" in ctx ->
                getSkill("scroll_explore")
            "purchase" in ctx || "buy" in ctx || "confirm" in ctx ->
                getSkill("confirm_action")
            "zoom" in ctx || "map" in ctx || "overview" in ctx ->
                getSkill("zoom_out")
            else -> null
        }
    }

    // ── Skill naming conventions ──────────────────────────────────────────────

    companion object {
        /** Skill situation keys the LearningEngine should use. */
        val KNOWN_SKILL_NAMES = listOf(
            "dismiss_dialog", "collect_resource", "skip_tutorial",
            "open_menu", "scroll_explore", "confirm_action",
            "retry_after_failure", "zoom_out",
        )

        fun skillKey(name: String) = "skill:$name"
    }
}
