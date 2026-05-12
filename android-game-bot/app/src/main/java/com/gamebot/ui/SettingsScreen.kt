package com.gamebot.ui

import android.content.Intent
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.gamebot.data.repository.MemoryRepository
import com.gamebot.service.GameBotAccessibilityService
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    activity: ComponentActivity,
    onBack: () -> Unit,
) {
    val context    = LocalContext.current
    val repository = remember { MemoryRepository(context) }
    val scope      = rememberCoroutineScope()

    var apiKey      by remember { mutableStateOf("") }
    var gamePackage by remember { mutableStateOf("") }
    var showKey     by remember { mutableStateOf(false) }
    var saved       by remember { mutableStateOf(false) }

    // Load current values
    LaunchedEffect(Unit) {
        apiKey      = repository.getApiKey()
        gamePackage = repository.getGamePackage()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {

            // ── Anthropic API Key ─────────────────────────────────────────────
            OutlinedTextField(
                value         = apiKey,
                onValueChange = { apiKey = it; saved = false },
                label         = { Text("Anthropic API Key") },
                placeholder   = { Text("sk-ant-...") },
                modifier      = Modifier.fillMaxWidth(),
                visualTransformation = if (showKey) VisualTransformation.None
                                       else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                trailingIcon  = {
                    IconButton(onClick = { showKey = !showKey }) {
                        Icon(
                            if (showKey) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                            contentDescription = "Toggle key visibility",
                        )
                    }
                },
                supportingText = { Text("Get your key at console.anthropic.com") },
            )

            // ── Game package ──────────────────────────────────────────────────
            OutlinedTextField(
                value         = gamePackage,
                onValueChange = { gamePackage = it; saved = false },
                label         = { Text("Game Package Name (optional)") },
                placeholder   = { Text("com.example.mygame") },
                modifier      = Modifier.fillMaxWidth(),
                supportingText = {
                    Text("Android package name — the bot will launch this game automatically. " +
                         "Leave empty to play whatever app is currently open.")
                },
                leadingIcon = { Icon(Icons.Default.SportsEsports, null) },
            )

            // ── Save button ───────────────────────────────────────────────────
            Button(
                onClick = {
                    scope.launch {
                        repository.setApiKey(apiKey)
                        repository.setGamePackage(gamePackage)
                        saved = true
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Icon(Icons.Default.Save, null)
                Spacer(Modifier.width(8.dp))
                Text(if (saved) "Saved!" else "Save Settings")
            }

            HorizontalDivider()

            // ── Accessibility service shortcut ────────────────────────────────
            val accessEnabled = GameBotAccessibilityService.isEnabled
            ListItem(
                headlineContent = { Text("Accessibility Service") },
                supportingContent = {
                    Text(if (accessEnabled)
                             "Enabled – GameBot can inject touch gestures"
                         else
                             "Disabled – tap to open Accessibility Settings")
                },
                trailingContent = {
                    if (accessEnabled)
                        Icon(Icons.Default.CheckCircle, null,
                             tint = MaterialTheme.colorScheme.primary)
                    else
                        Icon(Icons.Default.Error, null,
                             tint = MaterialTheme.colorScheme.error)
                },
                modifier = Modifier
                    .let { if (!accessEnabled)
                               it then Modifier  // tappable hint below
                           else it },
            )
            if (!accessEnabled) {
                OutlinedButton(
                    onClick = { activity.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.OpenInNew, null)
                    Spacer(Modifier.width(8.dp))
                    Text("Open Accessibility Settings")
                }
            }
        }
    }
}
