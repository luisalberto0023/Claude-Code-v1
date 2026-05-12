package com.gamebot

import android.app.Activity
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.gamebot.service.BotForegroundService
import com.gamebot.service.GameBotAccessibilityService
import com.gamebot.ui.HomeScreen
import com.gamebot.ui.SettingsScreen
import com.gamebot.ui.StatsScreen
import com.gamebot.ui.theme.GameBotTheme

class MainActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            GameBotTheme {
                BotApp(activity = this)
            }
        }
    }
}

@Composable
fun BotApp(activity: ComponentActivity) {
    val navController = rememberNavController()
    val botState by BotForegroundService.botState.collectAsStateWithLifecycle()

    // Screen-capture permission launcher
    val projectionManager = activity.getSystemService(MediaProjectionManager::class.java)
    var pendingResultCode by remember { mutableStateOf(0) }
    var pendingData       by remember { mutableStateOf<Intent?>(null) }

    val projectionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val intent = Intent(activity, BotForegroundService::class.java).apply {
                action = BotForegroundService.ACTION_START
                putExtra(BotForegroundService.EXTRA_RESULT_CODE, result.resultCode)
                putExtra(BotForegroundService.EXTRA_PROJECTION_DATA, result.data)
            }
            activity.startForegroundService(intent)
        }
    }

    val onStartBot: () -> Unit = {
        if (!GameBotAccessibilityService.isEnabled) {
            // Deep-link to Accessibility settings so the user can enable the service
            activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        } else {
            projectionLauncher.launch(projectionManager.createScreenCaptureIntent())
        }
    }

    val onStopBot: () -> Unit = {
        activity.startService(Intent(activity, BotForegroundService::class.java).apply {
            action = BotForegroundService.ACTION_STOP
        })
    }

    NavHost(navController = navController, startDestination = "home") {
        composable("home") {
            HomeScreen(
                botState       = botState,
                accessibilityEnabled = GameBotAccessibilityService.isEnabled,
                onStartBot     = onStartBot,
                onStopBot      = onStopBot,
                onNavigateToStats    = { navController.navigate("stats") },
                onNavigateToSettings = { navController.navigate("settings") },
            )
        }
        composable("stats") {
            StatsScreen(onBack = { navController.popBackStack() })
        }
        composable("settings") {
            SettingsScreen(
                activity = activity,
                onBack   = { navController.popBackStack() },
            )
        }
    }
}
