package com.futo.notes.browser

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import com.futo.notes.puppet.recordPuppetOpen

fun hasCustomTabsProvider(context: Context): Boolean =
    CustomTabsClient.getPackageName(context, null) != null

/** Launches in the browser's Custom Tab, with the usual browser intent as fallback. */
fun openInCustomTab(context: Context, url: String) {
    recordPuppetOpen(url)
    val uri = Uri.parse(url)
    if (hasCustomTabsProvider(context)) {
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setUrlBarHidingEnabled(false)
            .build()
            .launchUrl(context, uri)
    } else {
        context.startActivity(Intent(Intent.ACTION_VIEW, uri))
    }
}
