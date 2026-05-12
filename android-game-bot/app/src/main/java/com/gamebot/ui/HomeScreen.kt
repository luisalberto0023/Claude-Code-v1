package com.gamebot.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.gamebot.service.BotServiceState

/**
 * Main control screen.
 *
 * Shows:
 *  - Bot status (idle / playing / error)
 *  - Start / Stop button
 *  - Accessibility service setup warning if not enabled
 *  - Quick navigation to Stats and Settings
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    botState: BotServiceState,
    accessibilityEnabled: Boolean,
    onStartBot: () -> Unit,
    onStopBot: () -> Unit,
    onNavigateToStats: () -> Unit,
    onNavigateToSettings: () -> Unit,
) {
    val isRunning = botState is BotServiceState.Running
    val statusText = when (botState) {
        is BotServiceState.Idle    -> "Idle"
        is BotServiceState.Running -> botState.status
        is BotServiceState.Error   -> "Error: ${botState.message}"
    }
    val statusColor by animateColorAsState(
        targetValue = when (botState) {
            is BotServiceState.Running -> MaterialTheme.colorScheme.primary
            is BotServiceState.Error   -> MaterialTheme.colorScheme.error
            else                       -> MaterialTheme.colorScheme.onSurfaceVariant
        },
        label = "statusColor",
    )

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("GameBot") },
                actions = {
                    IconButton(onClick = onNavigateToStats) {
                        Icon(Icons.Default.Analytics, contentDescription = "Stats")
                    }
                    IconButton(onClick = onNavigateToSettings) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(24.dp, Alignment.CenterVertically),
        ) {

            // ── Status card ───────────────────────────────────────────────────
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors   = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.surfaceVariant
                ),
            ) {
                Column(
                    modifier = Modifier.padding(20.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text  = "Status",
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            imageVector = if (isRunning) Icons.Default.SmartToy else Icons.Default.SportsEsports,
                            contentDescription = null,
                            tint = statusColor,
                        )
                        Text(
                            text  = statusText,
                            style = MaterialTheme.typography.bodyLarge,
                            color = statusColor,
                            fontWeight = FontWeight.Medium,
                        )
                    }
                }
            }

            // ── Accessibility warning ─────────────────────────────────────────
            if (!accessibilityEnabled) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer,
                    ),
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(
                            Icons.Default.Warning,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onErrorContainer,
                        )
                        Column {
                            Text(
                                "Accessibility Service Required",
                                style = MaterialTheme.typography.titleSmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                "Tap Start and enable GameBot in Accessibility Settings to allow touch injection.",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                        }
                    }
                }
            }

            // ── How it works ─────────────────────────────────────────────────
            if (!isRunning) {
                Card(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Text("How GameBot works", style = MaterialTheme.typography.titleSmall,
                             fontWeight = FontWeight.SemiBold)
                        HowItWorksItem(Icons.Default.Visibility,      "Sees the game via screen capture")
                        HowItWorksItem(Icons.Default.Psychology,      "Uses Claude AI to understand & decide")
                        HowItWorksItem(Icons.Default.TouchApp,        "Injects taps/swipes via Accessibility")
                        HowItWorksItem(Icons.Default.School,          "Learns from every action taken")
                        HowItWorksItem(Icons.Default.EmojiEvents,     "Tracks achievements and progress")
                        HowItWorksItem(Icons.Default.RecordVoiceOver, "Completes tutorials automatically")
                    }
                }
            }

            Spacer(Modifier.weight(1f))

            // ── Start / Stop button ───────────────────────────────────────────
            Button(
                onClick = if (isRunning) onStopBot else onStartBot,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (isRunning)
                        MaterialTheme.colorScheme.error
                    else
                        MaterialTheme.colorScheme.primary,
                ),
            ) {
                Icon(
                    imageVector = if (isRunning) Icons.Default.Stop else Icons.Default.PlayArrow,
                    contentDescription = null,
                    modifier = Modifier.size(20.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    text  = if (isRunning) "Stop Bot" else "Start Bot",
                    style = MaterialTheme.typography.titleMedium,
                )
            }
        }
    }
}

@Composable
private fun HowItWorksItem(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment     = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null,
             tint = MaterialTheme.colorScheme.primary,
             modifier = Modifier.size(18.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium)
    }
}
