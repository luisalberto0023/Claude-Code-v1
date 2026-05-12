package com.gamebot.agent

import android.util.Log
import com.gamebot.model.ScreenAnalysis
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

private const val TAG = "VisionAnalyzer"

private val ANALYSIS_SCHEMA = """
Return a JSON object with EXACTLY these keys:

{
  "screen_type": "<loading|tutorial|gameplay|menu|dialog|shop|inventory|map|cutscene|game_over|victory|settings|unknown>",
  "objective": "<one sentence – what should the bot do right now>",
  "tutorial_instruction": "<verbatim tutorial hint text, or empty string>",
  "interactive_elements": [
    { "label": "<name>", "element_type": "<button|text_field|slider|toggle|icon|area>",
      "nx": <0.0-1.0>, "ny": <0.0-1.0>, "confidence": <0.0-1.0> }
  ],
  "game_state": {
    "health": <number or null>, "mana": <number or null>, "gold": <number or null>,
    "score": <number or null>, "level": <number or null>, "lives": <number or null>,
    "other": {}
  },
  "progress_indicators": {
    "quest_progress": "<text or null>", "tutorial_step": <int or null>,
    "stars": <int or null>, "completion_percent": <int or null>
  },
  "blocking_issues": ["<obstacle preventing progress>"],
  "suggested_action": {
    "type": "<tap|swipe|long_press|scroll_down|scroll_up|wait|back|text_input>",
    "nx": <0.0-1.0>, "ny": <0.0-1.0>,
    "params": {},
    "reasoning": "<why this action>"
  },
  "raw_description": "<2-3 sentence description>"
}
""".trimIndent()

/**
 * Sends screenshots to the Claude Vision API and parses the structured response.
 *
 * Uses OkHttp directly (no Retrofit) for simplicity and to keep the APK lean.
 * Calls [VISION_MODEL] for full analysis; [FAST_MODEL] for quick same-screen checks.
 */
class VisionAnalyzer(private val apiKey: String) {

    private val client = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(90, TimeUnit.SECONDS)
        .build()

    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }

    companion object {
        private const val API_URL     = "https://api.anthropic.com/v1/messages"
        private const val API_VERSION = "2023-06-01"
        private const val VISION_MODEL = "claude-opus-4-7"
        private const val FAST_MODEL   = "claude-sonnet-4-6"
        private const val MAX_TOKENS   = 2048
    }

    // ── Full analysis ─────────────────────────────────────────────────────────

    suspend fun analyse(imageBase64: String, context: String = ""): ScreenAnalysis =
        withContext(Dispatchers.IO) {
            val body = buildRequest(imageBase64, context, VISION_MODEL, MAX_TOKENS)
            try {
                val responseText = post(body)
                parse(responseText)
            } catch (e: Exception) {
                Log.e(TAG, "Vision analysis failed: ${e.message}")
                ScreenAnalysis(screenType = "unknown", objective = "Analysis unavailable")
            }
        }

    // ── Same-screen check ─────────────────────────────────────────────────────

    suspend fun isSameScreen(base64A: String, base64B: String): Boolean =
        withContext(Dispatchers.IO) {
            val body = buildJsonObject {
                put("model", FAST_MODEL)
                put("max_tokens", 8)
                putJsonArray("messages") {
                    addJsonObject {
                        put("role", "user")
                        putJsonArray("content") {
                            addJsonObject {
                                put("type", "text")
                                put("text", "Two game screenshots follow. Reply with one word: SAME or DIFFERENT.")
                            }
                            addJsonObject {
                                put("type", "image")
                                putJsonObject("source") {
                                    put("type", "base64")
                                    put("media_type", "image/png")
                                    put("data", base64A)
                                }
                            }
                            addJsonObject {
                                put("type", "image")
                                putJsonObject("source") {
                                    put("type", "base64")
                                    put("media_type", "image/png")
                                    put("data", base64B)
                                }
                            }
                        }
                    }
                }
            }.toString()
            try {
                "SAME" in post(body).uppercase()
            } catch (e: Exception) {
                false
            }
        }

    // ── Private helpers ───────────────────────────────────────────────────────

    private fun buildRequest(base64: String, context: String, model: String, maxTokens: Int): String =
        buildJsonObject {
            put("model", model)
            put("max_tokens", maxTokens)
            put("system",
                "You are the perception module of an autonomous mobile game-playing AI. " +
                "Analyse the screenshot and return ONLY valid JSON — no markdown, no prose."
            )
            putJsonArray("messages") {
                addJsonObject {
                    put("role", "user")
                    putJsonArray("content") {
                        addJsonObject {
                            put("type", "image")
                            putJsonObject("source") {
                                put("type", "base64")
                                put("media_type", "image/png")
                                put("data", base64)
                            }
                        }
                        addJsonObject {
                            put("type", "text")
                            put("text", buildString {
                                append("Analyse this mobile game screenshot.\n\n")
                                if (context.isNotBlank()) append("Context:\n$context\n\n")
                                append(ANALYSIS_SCHEMA)
                            })
                        }
                    }
                }
            }
        }.toString()

    @Throws(IOException::class)
    private fun post(body: String): String {
        val request = Request.Builder()
            .url(API_URL)
            .header("x-api-key", apiKey)
            .header("anthropic-version", API_VERSION)
            .header("content-type", "application/json")
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()

        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("API error ${response.code}: ${response.body?.string()}")
            }
            val root = Json.parseToJsonElement(response.body!!.string()).jsonObject
            return root["content"]!!.jsonArray[0].jsonObject["text"]!!.jsonPrimitive.content
        }
    }

    private fun parse(rawJson: String): ScreenAnalysis {
        val clean = rawJson
            .trimIndent()
            .removePrefix("```json").removePrefix("```")
            .removeSuffix("```")
            .trim()

        return try {
            val obj = Json.parseToJsonElement(clean).jsonObject
            ScreenAnalysis(
                screenType          = obj["screen_type"]?.jsonPrimitive?.content ?: "unknown",
                objective           = obj["objective"]?.jsonPrimitive?.content ?: "",
                tutorialInstruction = obj["tutorial_instruction"]?.jsonPrimitive?.content ?: "",
                interactiveElements = obj["interactive_elements"]?.jsonArray?.map { el ->
                    val e = el.jsonObject
                    com.gamebot.model.InteractiveElement(
                        label       = e["label"]?.jsonPrimitive?.content ?: "",
                        elementType = e["element_type"]?.jsonPrimitive?.content ?: "button",
                        nx          = e["nx"]?.jsonPrimitive?.float ?: 0.5f,
                        ny          = e["ny"]?.jsonPrimitive?.float ?: 0.5f,
                        confidence  = e["confidence"]?.jsonPrimitive?.float ?: 0.5f,
                    )
                } ?: emptyList(),
                blockingIssues = obj["blocking_issues"]?.jsonArray
                    ?.map { it.jsonPrimitive.content } ?: emptyList(),
                suggestedAction = obj["suggested_action"]?.jsonObject?.let { sa ->
                    com.gamebot.model.SuggestedAction(
                        type      = sa["type"]?.jsonPrimitive?.content ?: "tap",
                        nx        = sa["nx"]?.jsonPrimitive?.float ?: 0.5f,
                        ny        = sa["ny"]?.jsonPrimitive?.float ?: 0.5f,
                        reasoning = sa["reasoning"]?.jsonPrimitive?.content ?: "",
                    )
                } ?: com.gamebot.model.SuggestedAction(),
                rawDescription = obj["raw_description"]?.jsonPrimitive?.content ?: "",
            )
        } catch (e: Exception) {
            Log.w(TAG, "Parse failed: ${e.message}")
            ScreenAnalysis(screenType = "unknown", objective = "Parse error")
        }
    }
}
