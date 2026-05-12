package com.gamebot.model

import kotlinx.serialization.Serializable

@Serializable
data class ScreenAnalysis(
    val screenType: String          = "unknown",
    val objective: String           = "",
    val tutorialInstruction: String = "",
    val interactiveElements: List<InteractiveElement> = emptyList(),
    val gameState: GameState        = GameState(),
    val progressIndicators: ProgressIndicators = ProgressIndicators(),
    val blockingIssues: List<String> = emptyList(),
    val suggestedAction: SuggestedAction = SuggestedAction(),
    val rawDescription: String      = "",
) {
    val isInteractive: Boolean
        get() = screenType !in listOf("loading", "cutscene")

    val isBlocked: Boolean
        get() = blockingIssues.isNotEmpty()
}

@Serializable
data class InteractiveElement(
    val label: String       = "",
    val elementType: String = "button",   // button|text_field|slider|toggle|icon|area
    val nx: Float           = 0.5f,       // normalised x (0–1)
    val ny: Float           = 0.5f,       // normalised y (0–1)
    val confidence: Float   = 0.5f,
)

@Serializable
data class GameState(
    val health: Float? = null,
    val mana: Float?   = null,
    val gold: Long?    = null,
    val score: Long?   = null,
    val level: Int?    = null,
    val lives: Int?    = null,
    val other: Map<String, String> = emptyMap(),
)

@Serializable
data class ProgressIndicators(
    val questProgress: String? = null,
    val tutorialStep: Int?     = null,
    val stars: Int?            = null,
    val completionPercent: Int? = null,
)

@Serializable
data class SuggestedAction(
    val type: String               = "tap",
    val nx: Float                  = 0.5f,
    val ny: Float                  = 0.5f,
    val params: Map<String, String> = emptyMap(),
    val reasoning: String          = "",
)
