package com.gamebot.service

import android.app.*
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import com.gamebot.MainActivity
import com.gamebot.R
import com.gamebot.agent.GameAgent
import com.gamebot.data.repository.MemoryRepository
import com.gamebot.agent.VisionAnalyzer
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Foreground Service that keeps the bot alive while playing.
 *
 * Responsibilities:
 *  - Hold the MediaProjection token (screen recording permission)
 *  - Show a persistent notification so Android doesn't kill the process
 *  - Acquire a WakeLock so the CPU stays on during long gaming sessions
 *  - Start / stop the [GameAgent] coroutine loop
 *  - Broadcast status updates back to the UI via [botState]
 */
class BotForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.gamebot.START"
        const val ACTION_STOP  = "com.gamebot.STOP"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_PROJECTION_DATA = "projectionData"

        private const val CHANNEL_ID   = "gamebot_channel"
        private const val NOTIF_ID     = 1001

        val botState: MutableStateFlow<BotServiceState> =
            MutableStateFlow(BotServiceState.Idle)
    }

    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    private lateinit var screenCapture: ScreenCaptureService
    private lateinit var memory: MemoryRepository
    private lateinit var agent: GameAgent
    private var wakeLock: PowerManager.WakeLock? = null
    private var agentJob: Job? = null

    // ── Service lifecycle ─────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        screenCapture = ScreenCaptureService(applicationContext)
        memory        = MemoryRepository(applicationContext)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val resultCode     = intent.getIntExtra(EXTRA_RESULT_CODE, -1)
                val projectionData = intent.getParcelableExtra<Intent>(EXTRA_PROJECTION_DATA)
                if (projectionData != null) startBot(resultCode, projectionData)
            }
            ACTION_STOP -> stopBot()
        }
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopBot()
        scope.cancel()
        super.onDestroy()
    }

    // ── Bot control ───────────────────────────────────────────────────────────

    private fun startBot(resultCode: Int, projectionData: Intent) {
        startForeground(NOTIF_ID, buildNotification("Starting…"))

        // Keep CPU on
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "GameBot::WakeLock")
            .apply { acquire(4 * 60 * 60 * 1000L) } // max 4h session

        screenCapture.start(resultCode, projectionData)

        val apiKey = getApiKey()
        val analyzer = VisionAnalyzer(apiKey)
        agent = GameAgent(
            screenCapture    = screenCapture,
            accessibility    = GameBotAccessibilityService.instance!!,
            visionAnalyzer   = analyzer,
            memory           = memory,
            onStatusUpdate   = { status -> updateNotification(status); botState.value = BotServiceState.Running(status) },
            onComplete       = { stopBot() },
        )

        agentJob = scope.launch {
            botState.value = BotServiceState.Running("Playing…")
            agent.run()
        }
    }

    private fun stopBot() {
        agentJob?.cancel()
        agentJob = null
        screenCapture.stop()
        wakeLock?.release()
        wakeLock = null
        botState.value = BotServiceState.Idle
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "GameBot",
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = "Autonomous game bot status" }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun buildNotification(status: String): Notification {
        val tapIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            this, 0,
            Intent(this, BotForegroundService::class.java).apply { action = ACTION_STOP },
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("GameBot is playing")
            .setContentText(status)
            .setSmallIcon(R.drawable.ic_bot_notification)
            .setContentIntent(tapIntent)
            .addAction(0, "Stop", stopIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(status: String) {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIF_ID, buildNotification(status))
    }

    private fun getApiKey(): String {
        // Read from DataStore (set by the user in Settings screen)
        // Using runBlocking here is acceptable: this is a one-time initialisation call
        // on the service's worker thread, not the main thread.
        return runBlocking {
            memory.getApiKey()
        }
    }
}

// ── State model ───────────────────────────────────────────────────────────────

sealed class BotServiceState {
    data object Idle : BotServiceState()
    data class Running(val status: String) : BotServiceState()
    data class Error(val message: String) : BotServiceState()
}
