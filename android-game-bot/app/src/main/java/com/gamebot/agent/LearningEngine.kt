package com.gamebot.agent

import android.util.Log
import com.gamebot.data.db.KnowledgeEntity
import com.gamebot.data.db.StrategyEntity
import com.gamebot.data.repository.MemoryRepository
import com.gamebot.model.ScreenAnalysis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

private const val TAG = "LearningEngine"
private const val REFLECTION_MODEL = "claude-opus-4-7"

/**
 * Periodic reflection: turns raw action history into structured knowledge.
 *
 * After every [reflectEveryN] actions the engine:
 *  1. Reviews recent actions and their outcomes
 *  2. Extracts new game mechanics / controls knowledge
 *  3. Writes new strategies (situation → action mappings)
 *  4. Identifies recurring failure patterns
 *  5. Generates a recovery plan when stuck
 */
class LearningEngine(
    private val memory: MemoryRepository,
    private val apiKey: String,
    val reflectEveryN: Int = 25,
) {
    private val client = OkHttpClient.Builder()
        .readTimeout(120, TimeUnit.SECONDS).build()

    private var lastReflectionCount = 0

    fun shouldReflect(): Boolean =
        (memory.actionCount() - lastReflectionCount) >= reflectEveryN

    // ── Full reflection ───────────────────────────────────────────────────────

    suspend fun reflect(current: ScreenAnalysis) = withContext(Dispatchers.IO) {
        val prompt = """
The bot is playing a mobile game. Analyse its recent experience and return JSON.

=== GAME KNOWLEDGE ===
${memory.knowledgeSummary(30)}

=== STRATEGIES ===
${memory.strategiesSummary()}

=== RECENT ACTIONS (last $reflectEveryN) ===
${memory.recentActionsSummary(reflectEveryN)}

=== CURRENT STATE ===
screen_type: ${current.screenType}
objective: ${current.objective}
blocking: ${current.blockingIssues.joinToString(", ").ifEmpty { "none" }}

Return JSON:
{
  "new_knowledge": [
    {"category":"<controls|mechanics|ui|enemy|level|economy|story>",
     "fact":"<short unique fact>","details":"<elaboration>","confidence":<0-1>}
  ],
  "new_strategies": [
    {"situation":"<key>","action_type":"<tap|swipe|scroll_down|scroll_up|back|wait|long_press>",
     "nx":<0-1>,"ny":<0-1>,"description":"<what it achieves>"}
  ],
  "failure_patterns": ["<pattern>"],
  "recovery_plan": "<concrete next step when stuck>",
  "summary": "<2-3 sentences on what was learned>"
}
""".trimIndent()

        try {
            val raw = callClaude(prompt)
            val data = Json { ignoreUnknownKeys = true }.parseToJsonElement(
                raw.trim().removePrefix("```json").removePrefix("```").removeSuffix("```").trim()
            ).jsonObject

            // Persist knowledge
            data["new_knowledge"]?.jsonArray?.forEach { k ->
                val obj = k.jsonObject
                memory.addKnowledge(KnowledgeEntity(
                    category   = obj["category"]?.jsonPrimitive?.content ?: "general",
                    fact       = obj["fact"]?.jsonPrimitive?.content ?: return@forEach,
                    details    = obj["details"]?.jsonPrimitive?.content ?: "",
                    confidence = obj["confidence"]?.jsonPrimitive?.float ?: 1f,
                ))
            }

            // Persist strategies
            data["new_strategies"]?.jsonArray?.forEach { s ->
                val obj = s.jsonObject
                memory.upsertStrategy(StrategyEntity(
                    situation   = obj["situation"]?.jsonPrimitive?.content ?: return@forEach,
                    actionType  = obj["action_type"]?.jsonPrimitive?.content ?: "tap",
                    nx          = obj["nx"]?.jsonPrimitive?.float ?: 0.5f,
                    ny          = obj["ny"]?.jsonPrimitive?.float ?: 0.5f,
                    description = obj["description"]?.jsonPrimitive?.content ?: "",
                ))
            }

            lastReflectionCount = memory.actionCount()
            val summary = data["summary"]?.jsonPrimitive?.content ?: ""
            Log.i(TAG, "Reflection done: $summary")
            summary
        } catch (e: Exception) {
            Log.e(TAG, "Reflection failed: ${e.message}")
            ""
        }
    }

    // ── Tutorial extraction ───────────────────────────────────────────────────

    fun extractTutorialKnowledge(analysis: ScreenAnalysis) {
        if (analysis.tutorialInstruction.isBlank()) return
        memory.addKnowledge(KnowledgeEntity(
            category   = "mechanics",
            fact       = "tutorial: ${analysis.tutorialInstruction.take(80)}",
            details    = analysis.tutorialInstruction,
            confidence = 0.95f,
        ))
    }

    // ── Recovery plan ─────────────────────────────────────────────────────────

    suspend fun buildRecoveryPlan(current: ScreenAnalysis): List<Map<String, String>> =
        withContext(Dispatchers.IO) {
            val prompt = """
The game bot is STUCK. Propose up to 5 recovery actions (JSON).

screen_type: ${current.screenType}
objective: ${current.objective}
knowledge: ${memory.knowledgeSummary(15)}

{
  "recovery_actions": [
    {"type":"<tap|swipe|scroll_down|scroll_up|back|wait>",
     "nx":<0-1>,"ny":<0-1>,"reasoning":"<why>"}
  ]
}
""".trimIndent()

            try {
                val raw = callClaude(prompt)
                val clean = raw.trim()
                    .removePrefix("```json").removePrefix("```")
                    .removeSuffix("```").trim()
                Json.parseToJsonElement(clean).jsonObject["recovery_actions"]
                    ?.jsonArray?.map { a ->
                        val o = a.jsonObject
                        mapOf(
                            "type"      to (o["type"]?.jsonPrimitive?.content ?: "tap"),
                            "nx"        to (o["nx"]?.jsonPrimitive?.content ?: "0.5"),
                            "ny"        to (o["ny"]?.jsonPrimitive?.content ?: "0.5"),
                            "reasoning" to (o["reasoning"]?.jsonPrimitive?.content ?: ""),
                        )
                    } ?: fallbackRecovery()
            } catch (e: Exception) {
                Log.w(TAG, "Recovery plan failed: ${e.message}")
                fallbackRecovery()
            }
        }

    private fun fallbackRecovery() = listOf(
        mapOf("type" to "back",        "nx" to "0.5", "ny" to "0.5", "reasoning" to "escape screen"),
        mapOf("type" to "scroll_down", "nx" to "0.5", "ny" to "0.5", "reasoning" to "look for hidden elements"),
        mapOf("type" to "tap",         "nx" to "0.5", "ny" to "0.9", "reasoning" to "try bottom of screen"),
        mapOf("type" to "wait",        "nx" to "0.5", "ny" to "0.5", "reasoning" to "wait for loading"),
    )

    // ── API call ──────────────────────────────────────────────────────────────

    private fun callClaude(prompt: String): String {
        val body = buildJsonObject {
            put("model", REFLECTION_MODEL)
            put("max_tokens", 3000)
            put("system",
                "You are the learning module of an autonomous game-playing AI. " +
                "Return ONLY valid JSON — no markdown, no prose outside the JSON.")
            putJsonArray("messages") {
                addJsonObject {
                    put("role", "user")
                    put("content", prompt)
                }
            }
        }.toString()

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
}
