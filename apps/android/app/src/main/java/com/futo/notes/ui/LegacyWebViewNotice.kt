package com.futo.notes.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.webkit.WebView
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * Minimum System WebView Chromium major version the embedded editor can run in.
 *
 * The editor bundle targets ES2020 (optional chaining / nullish coalescing),
 * which only *parses* on Chromium 80+, and Svelte 5's runtime additionally calls
 * String.prototype.replaceAll (Chromium 85), shimmed back down to 80 in
 * editor.html. Below this floor the bundle throws on load and the editor never
 * mounts — a blank pane (github#8) — so the shell shows [LegacyWebViewNotice]
 * instead. Keep in step with `vite.editor.config.ts`'s build `target`.
 */
const val MIN_SUPPORTED_WEBVIEW_MAJOR = 80

/**
 * Chromium major version from a WebView versionName like "83.0.4103.106" → 83;
 * null when absent or unparseable. Pure seam, unit-tested in
 * LegacyWebViewNoticeTest without a device.
 */
fun parseChromiumMajor(versionName: String?): Int? =
    versionName?.substringBefore('.')?.toIntOrNull()

/**
 * Whether a WebView versionName is new enough to run the editor. An unknown
 * version (null / unparseable) is treated as supported so a parsing quirk never
 * hides a working editor behind the notice.
 */
fun isSupportedWebViewVersion(versionName: String?): Boolean {
    val major = parseChromiumMajor(versionName) ?: return true
    return major >= MIN_SUPPORTED_WEBVIEW_MAJOR
}

/** The active System WebView's Chromium major version (e.g. 83), or null when
 *  it can't be read. */
fun webViewChromiumMajor(): Int? =
    parseChromiumMajor(WebView.getCurrentWebViewPackage()?.versionName)

/** True when the System WebView is too old to run the editor (below the floor). */
fun isWebViewTooOldForEditor(): Boolean =
    !isSupportedWebViewVersion(WebView.getCurrentWebViewPackage()?.versionName)

/**
 * Shown in place of the editor WebView when [isWebViewTooOldForEditor] is true.
 * The rest of the app (native Compose list/search/settings) still works — only
 * the editor needs a modern engine — so this fills just the editor pane below
 * the note's native title, leaving the back button reachable.
 */
@Composable
fun LegacyWebViewNotice(modifier: Modifier = Modifier) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val current = webViewChromiumMajor()

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
            "Update Android System WebView",
            style = FutoType.title,
            color = c.textPrimary,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(12.dp))
        Text(
            buildString {
                append("FUTO Notes' editor needs Android System WebView ")
                append(MIN_SUPPORTED_WEBVIEW_MAJOR)
                append(" or newer. ")
                if (current != null) append("This device has version $current. ")
                append("Update it from your app store, then reopen the note.")
            },
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
            Text("Update WebView", style = FutoType.body, fontWeight = FontWeight.SemiBold)
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
    val pkg = WebView.getCurrentWebViewPackage()?.packageName ?: "com.google.android.webview"
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
