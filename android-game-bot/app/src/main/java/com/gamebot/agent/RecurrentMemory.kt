package com.gamebot.agent

/**
 * Rolling text-based recurrent memory, directly inspired by SIMA-2.
 *
 * SIMA-2 insight:
 *   "Gemini Pro produces a text-based summary that it receives on the NEXT call,
 *    effectively serving as a form of recurrent memory and allowing the system
 *    to maintain a long-horizon context that persists beyond the immediate
 *    context window."
 *
 * Instead of dumping raw action history into every prompt (which hits token limits
 * fast), we maintain a compact, ever-updated NARRATIVE SUMMARY of:
 *   - What game we are playing and what we understand about it
 *   - What we have accomplished so far (key milestones)
 *   - What we are currently trying to do
 *   - What we have tried that did not work
 *   - Open questions / things to explore
 *
 * The HierarchicalPlanner's slow-loop updates this summary each cycle.
 * Every LLM call receives it as compact, high-signal context.
 */
class RecurrentMemory {

    // Current rolling summary — starts empty, grows richer over time
    var summary: String = ""
        private set

    // Structured fields for UI display
    var currentGoal: String       = ""
    var lastNarration: String     = ""
    var lastRewardScore: Float    = -1f
    var sessionHighlights: MutableList<String> = mutableListOf()

    fun update(newSummary: String) {
        summary = newSummary
    }

    fun recordGoalScore(goal: String, score: Float) {
        lastRewardScore = score
        if (score >= 7f) {
            sessionHighlights.add("✓ $goal (score ${score.toInt()}/10)")
            if (sessionHighlights.size > 20) sessionHighlights.removeFirst()
        }
    }

    fun addHighlight(text: String) {
        sessionHighlights.add(text)
        if (sessionHighlights.size > 20) sessionHighlights.removeFirst()
    }

    /** Compact string to inject into every LLM prompt. */
    fun toPromptContext(): String = buildString {
        if (summary.isNotBlank()) {
            appendLine("=== MEMORY SUMMARY ===")
            appendLine(summary)
        }
        if (sessionHighlights.isNotEmpty()) {
            appendLine("=== SESSION HIGHLIGHTS ===")
            sessionHighlights.takeLast(8).forEach { appendLine(it) }
        }
    }

    fun reset() {
        summary = ""
        currentGoal = ""
        lastNarration = ""
        lastRewardScore = -1f
        sessionHighlights.clear()
    }
}
