package com.gamebot.data.repository

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import com.gamebot.data.dao.BotDao
import com.gamebot.data.db.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.runBlocking

private val Context.dataStore by preferencesDataStore(name = "bot_settings")
private val KEY_API_KEY      = stringPreferencesKey("anthropic_api_key")
private val KEY_GAME_PACKAGE = stringPreferencesKey("game_package")

/**
 * Single source of truth for all bot memory and settings.
 * Wraps both the Room [BotDatabase] and DataStore preferences.
 */
class MemoryRepository(private val context: Context) {

    private val db: BotDatabase = BotDatabase.get(context)
    private val dao: BotDao     = db.botDao()

    // ── Settings (DataStore) ──────────────────────────────────────────────────

    suspend fun getApiKey(): String =
        context.dataStore.data.map { it[KEY_API_KEY] ?: "" }.first()

    fun getApiKeySync(): String = runBlocking { getApiKey() }

    suspend fun setApiKey(key: String) {
        context.dataStore.edit { it[KEY_API_KEY] = key }
    }

    suspend fun getGamePackage(): String =
        context.dataStore.data.map { it[KEY_GAME_PACKAGE] ?: "" }.first()

    suspend fun setGamePackage(pkg: String) {
        context.dataStore.edit { it[KEY_GAME_PACKAGE] = pkg }
    }

    val apiKeyFlow: Flow<String>
        get() = context.dataStore.data.map { it[KEY_API_KEY] ?: "" }

    // ── Actions ───────────────────────────────────────────────────────────────

    fun logAction(action: ActionEntity): Long = runBlocking { dao.insertAction(action) }

    fun actionCount(): Int = dao.actionCount()

    suspend fun recentActions(n: Int = 20): List<ActionEntity> = dao.recentActions(n)

    suspend fun isStuck(threshold: Int = 12): Boolean =
        dao.noChangeCount(threshold) >= threshold

    suspend fun recentActionsSummary(n: Int = 15): String {
        val actions = dao.recentActions(n).reversed()
        if (actions.isEmpty()) return "No actions yet."
        return actions.joinToString("\n") {
            "${it.actionType} @ (%.2f,%.2f) on ${it.screenType} → ${it.outcome}"
                .format(it.nx, it.ny)
        }
    }

    // ── Strategies ────────────────────────────────────────────────────────────

    fun upsertStrategy(strategy: StrategyEntity) = runBlocking {
        val existing = dao.strategiesForSituation(strategy.situation)
            .firstOrNull { it.actionType == strategy.actionType }
        if (existing != null) dao.updateStrategy(existing.copy(
            nx = strategy.nx, ny = strategy.ny,
            description = strategy.description,
            updatedAt = System.currentTimeMillis(),
        ))
        else dao.insertStrategy(strategy)
    }

    fun getBestStrategy(situation: String): StrategyEntity? = runBlocking {
        dao.bestStrategy(situation)
    }

    suspend fun strategiesSummary(): String {
        val strats = dao.allStrategies()
        if (strats.isEmpty()) return "No strategies yet."
        return strats.take(20).joinToString("\n") {
            "[${it.situation}] ${it.actionType} @(%.2f,%.2f) – ${it.description} (${(it.successRate*100).toInt()}%%, n=${it.successCount+it.failureCount})"
                .format(it.nx, it.ny)
        }
    }

    // ── Knowledge ─────────────────────────────────────────────────────────────

    fun addKnowledge(k: KnowledgeEntity) = runBlocking { dao.insertKnowledge(k) }

    suspend fun knowledgeSummary(max: Int = 40): String {
        val items = dao.allKnowledge(max)
        if (items.isEmpty()) return "No game knowledge yet."
        return items.joinToString("\n") { "[${it.category}] ${it.fact}: ${it.details}" }
    }

    // ── Achievements ──────────────────────────────────────────────────────────

    fun recordAchievement(a: AchievementEntity) = runBlocking { dao.insertAchievement(a) }

    val achievementsFlow: Flow<List<AchievementEntity>> = dao.achievementsFlow()

    suspend fun achievementsSummary(): String {
        val ach = dao.achievements()
        if (ach.isEmpty()) return "No achievements yet."
        return ach.joinToString("\n") { "✓ ${it.title}: ${it.description}" }
    }

    // ── Sessions ──────────────────────────────────────────────────────────────

    fun startSession(): Long = runBlocking { dao.insertSession(SessionEntity()) }

    fun endSession(id: Long, notes: String = "") = runBlocking {
        dao.closeSession(id, System.currentTimeMillis(), actionCount(), notes)
    }

    // ── Context builder (for VisionAnalyzer prompts) ──────────────────────────

    fun buildContext(): String = runBlocking {
        buildString {
            append("=== RECENT ACTIONS ===\n")
            append(recentActionsSummary(10)).append("\n\n")
            append("=== GAME KNOWLEDGE ===\n")
            append(knowledgeSummary(20)).append("\n\n")
            append("=== ACHIEVEMENTS ===\n")
            append(achievementsSummary())
        }
    }
}
