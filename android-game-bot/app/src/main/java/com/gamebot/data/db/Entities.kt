package com.gamebot.data.db

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// ── Action history ────────────────────────────────────────────────────────────

@Entity(tableName = "action_history")
data class ActionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val screenType: String,
    val actionType: String,
    val nx: Float,
    val ny: Float,
    val reasoning: String = "",
    val outcome: String,            // success | failure | no_change | progress
    val timestamp: Long = System.currentTimeMillis(),
)

// ── Strategies ────────────────────────────────────────────────────────────────

@Entity(
    tableName = "strategies",
    indices = [Index(value = ["situation", "actionType"], unique = true)],
)
data class StrategyEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val situation: String,
    val actionType: String,
    val nx: Float,
    val ny: Float,
    val description: String,
    val successCount: Int = 0,
    val failureCount: Int = 0,
    val updatedAt: Long = System.currentTimeMillis(),
) {
    val successRate: Float
        get() = if (successCount + failureCount == 0) 0f
                else successCount.toFloat() / (successCount + failureCount)
}

// ── Game knowledge ────────────────────────────────────────────────────────────

@Entity(
    tableName = "knowledge",
    indices = [Index(value = ["fact"], unique = true)],
)
data class KnowledgeEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val category: String,
    val fact: String,
    val details: String = "",
    val confidence: Float = 1f,
    val updatedAt: Long = System.currentTimeMillis(),
)

// ── Achievements ──────────────────────────────────────────────────────────────

@Entity(
    tableName = "achievements",
    indices = [Index(value = ["title"], unique = true)],
)
data class AchievementEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val description: String,
    val screenType: String,
    val actionCount: Int,
    val timestamp: Long = System.currentTimeMillis(),
)

// ── Sessions ──────────────────────────────────────────────────────────────────

@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startedAt: Long = System.currentTimeMillis(),
    val endedAt: Long? = null,
    val totalActions: Int = 0,
    val notes: String = "",
)
