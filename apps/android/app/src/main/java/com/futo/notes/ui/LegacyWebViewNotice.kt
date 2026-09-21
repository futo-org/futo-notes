package com.futo.notes.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.WebSettings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import com.futo.notes.localization.LocalLocalization

/**
 * Shown in place of the editor WebView when the engine can't run the bundle
 * ([isEditorPaneUnavailable]). The rest of the app (native Compose
 * list/search/settings) still works — only the editor needs a modern engine —
 * so this fills just the editor pane below the note's native title, leaving the
 * back button reachable.
 */
@Composable
fun LegacyWebViewNotice(modifier: Modifier = Modifier) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    val context = LocalContext.current
    // The provider and its engine are fixed for the app's lifetime, so resolve
    // the wording once instead of on every recomposition.
    val message = remember {
        val provider = currentWebViewProvider()
        editorEngineNoticeMessage(
            chromiumMajor = parseChromiumMajorFromUserAgent(
                runCatching { WebSettings.getDefaultUserAgent(context) }.getOrNull(),
            ),
            providerName = provider?.packageName,
            providerVersion = provider?.versionName,
        )
    }

    Column(
        modifier = modifier.fillMaxSize().padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(
            Icons.Filled.Warning,
            contentDescription = null,
            tint = c.textAccent,
            modifier = Modifier.size(40.dp),
        )
        Spacer(Modifier.height(16.dp))
        Text(
            localization.localizedText("editor.android.legacyWebView.heading"),
            style = FutoType.title,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            localization.localizedText(message.path, message.arguments),
            style = FutoType.body,
            color = c.textSecondary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        Button(
            onClick = { openSystemWebViewListing(context) },
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.textOnInk),
            shape = RoundedCornerShape(FutoRadius.pill),
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Text(
                localization.localizedText("editor.android.legacyWebView.updateAction"),
                style = FutoType.body,
                fontWeight = FontWeight.SemiBold,
            )
        }
    }
}

/**
 * Open the System WebView package so the user can update it. Prefers the app
 * store listing (`market://`), falling back to the app's details screen when no
 * store handles it — de-Googled devices (the ones most likely to be stuck on an
 * old WebView) have no Play Store but can still update via their own store from
 * that screen.
 */
private fun openSystemWebViewListing(context: Context) {
    val pkg = currentWebViewProvider()?.packageName ?: "com.google.android.webview"
    val flags = Intent.FLAG_ACTIVITY_NEW_TASK
    try {
        context.startActivity(
            Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$pkg")).addFlags(flags),
        )
    } catch (_: ActivityNotFoundException) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
                    .addFlags(flags),
            )
        } catch (_: ActivityNotFoundException) {
            // No store and no settings deep-link available; the on-screen text
            // still tells the user what to update.
        }
    }
}
