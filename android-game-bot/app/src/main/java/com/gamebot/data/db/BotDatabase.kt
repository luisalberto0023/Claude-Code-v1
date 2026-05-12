package com.gamebot.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import com.gamebot.data.dao.BotDao

@Database(
    entities = [
        ActionEntity::class,
        StrategyEntity::class,
        KnowledgeEntity::class,
        AchievementEntity::class,
        SessionEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class BotDatabase : RoomDatabase() {

    abstract fun botDao(): BotDao

    companion object {
        @Volatile private var INSTANCE: BotDatabase? = null

        fun get(context: Context): BotDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    BotDatabase::class.java,
                    "gamebot.db",
                )
                    .fallbackToDestructiveMigration()
                    .build()
                    .also { INSTANCE = it }
            }
    }
}
