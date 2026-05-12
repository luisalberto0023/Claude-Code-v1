package com.gamebot.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.EmojiEvents
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.gamebot.data.db.AchievementEntity
import com.gamebot.data.repository.MemoryRepository

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StatsScreen(onBack: () -> Unit) {
    val context    = LocalContext.current
    val repository = remember { MemoryRepository(context) }

    val achievements by repository.achievementsFlow.collectAsStateWithLifecycle(emptyList())
    val actionCount  = remember { repository.actionCount() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Bot Statistics") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        }
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(8.dp)) }

            // ── Summary cards ─────────────────────────────────────────────────
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    StatCard("Total Actions", actionCount.toString(), Modifier.weight(1f))
                    StatCard("Achievements", achievements.size.toString(), Modifier.weight(1f))
                }
            }

            // ── Achievements list ─────────────────────────────────────────────
            if (achievements.isNotEmpty()) {
                item {
                    Text(
                        "Achievements",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                items(achievements, key = { it.id }) { ach ->
                    AchievementCard(ach)
                }
            } else {
                item {
                    Box(
                        modifier = Modifier.fillMaxWidth().padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            "No achievements yet. Start the bot to begin playing!",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }

            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun StatCard(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier = modifier) {
        Column(
            modifier = Modifier.padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
            Text(label, style = MaterialTheme.typography.labelMedium,
                 color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun AchievementCard(ach: AchievementEntity) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Default.EmojiEvents,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Column {
                Text(ach.title, style = MaterialTheme.typography.titleSmall,
                     fontWeight = FontWeight.SemiBold)
                Text(ach.description, style = MaterialTheme.typography.bodySmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("After ${ach.actionCount} actions",
                     style = MaterialTheme.typography.labelSmall,
                     color = MaterialTheme.colorScheme.outline)
            }
        }
    }
}
