package com.futo.notes.localization

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalConfiguration

val LocalLocalization = staticCompositionLocalOf<Localization> {
    error("Localization is not installed")
}

data class LocalizedMessage(
    val path: String,
    val arguments: Map<String, Any> = emptyMap(),
)

@Composable
fun ProvideLocalization(content: @Composable () -> Unit) {
    val languageTags = LocalConfiguration.current.locales.toLanguageTags()
    val localization = androidx.compose.runtime.remember(languageTags) {
        Localization.system(languageTags.split(',').filter(String::isNotBlank))
    }
    CompositionLocalProvider(LocalLocalization provides localization, content = content)
}
