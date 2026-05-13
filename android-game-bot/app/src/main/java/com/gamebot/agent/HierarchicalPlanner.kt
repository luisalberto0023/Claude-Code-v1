package com.gamebot.agent

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

private const val TAG = "HierarchicalPlanner"

/**
 * Two-tier hierarchical planning loop, directly inspired by SIMA-2.
 *
 * SIMA-2 insight:
 *   "Gemini Pro operates at a SLOWER cadence, reasoning over recent video
 *    history to issue natural language instructions to the SIMA 2 agent,
 *    and produces a text-based summary that it receives on the NEXT call,
 *    effectively serving as a form of recurrent memory."
 *
 * Our implementation:
 *
 *   SLOW LOOP (every ~15 seconds / N fast steps)
 *   ──────────────────────────────────────────────────────
 *   Input:  recent screenshot + rolling memory summary + action history
 *   Model:  claude-opus-4-7  (deep reasoning)
 *   Output: ① high-level goal for the next N steps
 *           ② updated rolling memory summary (recurrent context)
 *           ③ intent narration ("I'm going to open the inventory…")
 *           ④ self-generated next sub-task when current one completes
 *
 *   FAST LOOP (every ~2 seconds) — handled by GameAgent/VisionAnalyzer
 *   ──────────────────────────────────────────────────────
 *   Input:  screenshot + high-level goal from slow loop
 *   Model:  claude-sonnet-4-6  (low latency)
 *   Output: single concrete action (tap/swipe/…)
 *
 * The slow loop also acts as a REWARD MODEL: after a goal is completed it
 * scores its own performance (0–10) and logs it as a strategy outcome.
 */
class HierarchicalPlanner(private val apiKey: String) {

    // ── State ─────────────────────────────────────────────────────────────────

    /** Rolling text summary — passed back to the planner on every call (recurrent memory). */
    var rollingSummary: String = ""
        private set

    /** Current high-level goal issued to the fast loop. */
    var currentGoal: String = "Explore the game and understand the interface"
        private set

    /** Current intent narration (what the bot says it's doing). */
    var currentNarration: String = ""
        private set

    /** How many fast-loop steps have run under the current slow-loop goal. */
    private var fastStepsSinceSlowLoop = 0
    private val slowLoopEveryN = 12   // trigger slow loop every N fast steps

    private val client = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS).build()

    // ── API ───────────────────────────────────────────────────────────────────

    /**
     * Called by the fast loop before each action.
     * Returns the current high-level goal (may be stale; updated by [triggerSlowLoop]).
     * Automatically triggers the slow loop when enough fast steps have accumulated.
     */
    suspend fun tick(
        imageBase64: String,
        recentActionsSummary: String,
        knowledgeSummary: String,
    ): String {
        fastStepsSinceSlowLoop++
        if (fastStepsSinceSlowLoop >= slowLoopEveryN) {
            triggerSlowLoop(imageBase64, recentActionsSummary, knowledgeSummary)
            fastStepsSinceSlowLoop = 0
        }
        return currentGoal
    }

    /**
     * Force a slow-loop planning cycle (e.g. when stuck, or on game start).
     */
    suspend fun triggerSlowLoop(
        imageBase64: String,
        recentActionsSummary: String,
        knowledgeSummary: String,
    ) = withContext(Dispatchers.IO) {
        val prompt = buildSlowLoopPrompt(recentActionsSummary, knowledgeSummary)

        val body = buildJsonObject {
            put("model", "claude-opus-4-7")
            put("max_tokens", 1024)
            put("system",
                "You are the HIGH-LEVEL PLANNER of an autonomous mobile game-playing AI. " +
                "Your job is to set goals and maintain situational awareness. " +
                "You run every ~30 seconds and issue goals to a faster execution agent. " +
                "Reply ONLY with valid JSON — no markdown, no prose outside the JSON.")
            putJsonArray("messages") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("content") {
                        addJsonObject {
                            put("type", "image")
                            putJsonObject("source") {
                                put("type", "base64")
                                put("media_type", "image/png")
                                put("data", imageBase64)
                            }
                        }
                        addJsonObject { put("type", "text"); put("text", prompt) }
                    }
                }
            }
        }.toString()

        try {
            val raw = callApi(body)
            val obj = Json { ignoreUnknownKeys = true }
                .parseToJsonElement(raw.cleanJson()).jsonObject

            currentGoal      = obj["high_level_goal"]?.jsonPrimitive?.content ?: currentGoal
            currentNarration = obj["narration"]?.jsonPrimitive?.content ?: ""
            rollingSummary   = obj["updated_memory_summary"]?.jsonPrimitive?.content ?: rollingSummary

            Log.i(TAG, "SLOW LOOP → goal: $currentGoal")
            Log.i(TAG, "SLOW LOOP → narration: $currentNarration")
        } catch (e: Exception) {
            Log.e(TAG, "Slow loop failed: ${e.message}")
        }
    }

    /**
     * Score a completed goal attempt. Returns 0–10.
     * SIMA-2 insight: "a reward model scores each attempt."
     */
    suspend fun scoreGoalAttempt(
        goal: String,
        imageBase64: String,
        outcomesSummary: String,
    ): Float = withContext(Dispatchers.IO) {
        val prompt = """
You are a reward model for a game-playing AI.

Goal that was attempted: "$goal"
Actions taken: $outcomesSummary

Looking at the current game screenshot, score how well the goal was achieved.
Return JSON: {"score": <0-10>, "reason": "<one sentence>"}
""".trimIndent()

        try {
            val body = buildJsonObject {
                put("model", "claude-sonnet-4-6")
                put("max_tokens", 128)
                putJsonArray("messages") {
                    addJsonObject {
                        put("role", "user")
                        putJsonArray("content") {
                            addJsonObject {
                                put("type", "image")
                                putJsonObject("source") {
                                    put("type", "base64"); put("media_type", "image/png"); put("data", imageBase64)
                                }
                            }
                            addJsonObject { put("type", "text"); put("text", prompt) }
                        }
                    }
                }
            }.toString()
            val raw  = callApi(body)
            val obj  = Json.parseToJsonElement(raw.cleanJson()).jsonObject
            val score = obj["score"]?.jsonPrimitive?.float ?: 5f
            val reason = obj["reason"]?.jsonPrimitive?.content ?: ""
            Log.i(TAG, "REWARD  score=$score  reason=$reason")
            score
        } catch (e: Exception) {
            Log.w(TAG, "Reward scoring failed: ${e.message}")
            5f
        }
    }

    /**
     * Generate the next self-improvement task.
     * SIMA-2 insight: "a separate Gemini model generates new tasks for the agent."
     */
    suspend fun generateNextTask(
        imageBase64: String,
        achievementsSummary: String,
        knowledgeSummary: String,
    ): String = withContext(Dispatchers.IO) {
        val prompt = """
You are a task generator for an autonomous game-playing AI.

What the bot has already achieved:
$achievementsSummary

Game knowledge:
$knowledgeSummary

Looking at the current game screenshot, generate ONE specific, achievable next task
that would meaningfully progress the game or deepen understanding.

Return JSON: {"task": "<concrete task description>", "reasoning": "<why this task>"}
""".trimIndent()

        try {
            val body = buildJsonObject {
                put("model", "claude-sonnet-4-6")
                put("max_tokens", 256)
                putJsonArray("messages") {
                    addJsonObject {
                        put("role", "user")
                        putJsonArray("content") {
                            addJsonObject {
                                put("type", "image")
                                putJsonObject("source") {
                                    put("type", "base64"); put("media_type", "image/png"); put("data", imageBase64)
                                }
                            }
                            addJsonObject { put("type", "text"); put("text", prompt) }
                        }
                    }
                }
            }.toString()
            val raw = callApi(body)
            val obj = Json.parseToJsonElement(raw.cleanJson()).jsonObject
            val task = obj["task"]?.jsonPrimitive?.content ?: currentGoal
            Log.i(TAG, "SELF-TASK → $task")
            task
        } catch (e: Exception) {
            "Continue exploring the game"
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private fun buildSlowLoopPrompt(actions: String, knowledge: String): String = """
=== ROLLING MEMORY (from last planning cycle) ===
$rollingSummary

=== RECENT ACTIONS ===
$actions

=== GAME KNOWLEDGE ===
$knowledge

=== CURRENT SCREENSHOT ===
(see image above)

Based on all of the above, return JSON with EXACTLY these keys:
{
  "high_level_goal": "<one concrete goal for the next ~30 seconds of play>",
  "narration": "<one sentence: what you intend to do and why>",
  "updated_memory_summary": "<2-4 sentences summarising the game situation, progress, and open questions — this will be your memory next cycle>",
  "sub_tasks": ["<step 1>", "<step 2>", ...]
}

Rules:
- The goal must be specific and actionable (not 'play better')
- The memory summary must capture what's important for future planning
- Sub-tasks should be 2–5 concrete steps to achieve the goal
""".trimIndent()

    private fun callApi(body: String): String {
        val request = Request.Builder()
            .url("https://api.anthropic.com/v1/messages")
            .header("x-api-key", apiKey)
            .header("anthropic-version", "2023-06-01")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        client.newCall(request).execute().use { resp ->
            if (!resp.isSuccessful) throw Exception("API ${resp.code}: ${resp.body?.string()}")
            val root = Json.parseToJsonElement(resp.body!!.string()).jsonObject
            return root["content"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        }
    }

    private fun String.cleanJson() = trim()
        .removePrefix("```json").removePrefix("```")
        .removeSuffix("```").trim()
}
