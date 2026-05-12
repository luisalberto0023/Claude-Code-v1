package com.gamebot.data.dao

import androidx.room.*
import com.gamebot.data.db.*
import kotlinx.coroutines.flow.Flow

@Dao
interface BotDao {

    // ── Action history ────────────────────────────────────────────────────────

    @Insert
    suspend fun insertAction(action: ActionEntity): Long

    @Query("SELECT COUNT(*) FROM action_history")
    fun actionCount(): Int

    @Query("SELECT * FROM action_history ORDER BY id DESC LIMIT :n")
    suspend fun recentActions(n: Int): List<ActionEntity>

    @Query("""
        SELECT COUNT(*) FROM action_history
        WHERE id IN (SELECT id FROM action_history ORDER BY id DESC LIMIT :n)
          AND outcome IN ('no_change','failure')
    """)
    suspend fun noChangeCount(n: Int): Int

    // ── Strategies ────────────────────────────────────────────────────────────

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertStrategy(strategy: StrategyEntity): Long

    @Update
    suspend fun updateStrategy(strategy: StrategyEntity)

    @Query("SELECT * FROM strategies WHERE situation = :situation ORDER BY successCount DESC")
    suspend fun strategiesForSituation(situation: String): List<StrategyEntity>

    @Query("SELECT * FROM strategies ORDER BY successCount DESC LIMIT 20")
    suspend fun allStrategies(): List<StrategyEntity>

    @Query("SELECT * FROM strategies WHERE situation = :situation ORDER BY successCount DESC LIMIT 1")
    suspend fun bestStrategy(situation: String): StrategyEntity?

    // ── Knowledge ─────────────────────────────────────────────────────────────

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertKnowledge(k: KnowledgeEntity): Long

    @Query("SELECT * FROM knowledge ORDER BY confidence DESC LIMIT :n")
    suspend fun allKnowledge(n: Int = 50): List<KnowledgeEntity>

    // ── Achievements ──────────────────────────────────────────────────────────

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAchievement(a: AchievementEntity): Long

    @Query("SELECT * FROM achievements ORDER BY timestamp ASC")
    fun achievementsFlow(): Flow<List<AchievementEntity>>

    @Query("SELECT * FROM achievements ORDER BY timestamp ASC")
    suspend fun achievements(): List<AchievementEntity>

    // ── Sessions ──────────────────────────────────────────────────────────────

    @Insert
    suspend fun insertSession(s: SessionEntity): Long

    @Query("UPDATE sessions SET endedAt=:endedAt, totalActions=:total, notes=:notes WHERE id=:id")
    suspend fun closeSession(id: Long, endedAt: Long, total: Int, notes: String)
}
