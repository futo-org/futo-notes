package com.futo.notes.sync.hosted

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent

/**
 * The browser surface for hosted sign-in, checkout, and the customer portal
 * (ADR 0003, decision 1): a Chrome Custom Tab over the app, keeping the
 * browser's own cookies so an existing FUTO session is one tap. An embedded
 * WebView was rejected — isolated cookies make every login a typed one, and
 * identity providers block them.
 *
 * Nothing comes back through the tab. There is no URL scheme, App Link, or
 * return redirect anywhere in this flow: the app asks the server what happened
 * (`awaitSignIn`, `awaitEntitled`). So the only thing the tab itself reports is
 * the person coming back to the app, which [onAppPaused]/[onAppResumed] detect
 * and report as `onDismiss` so the wait can be cancelled.
 *
 * **Fallback.** A device with no Custom Tabs provider — a bare emulator image,
 * a de-Googled phone whose browser does not implement the service — gets a
 * plain `ACTION_VIEW`. The person's journey is identical; only the chrome
 * differs. A device with no browser at all raises [ActivityNotFoundException],
 * which the wizard reports as a sentence.
 */
class CustomTabsAuthSheet(private val activity: Activity) {
    private enum class Phase {
        /** Nothing open. */
        IDLE,

        /** A tab was launched; we have not left the app yet. */
        LAUNCHED,

        /** We are behind the browser. The next resume is the person's return. */
        IN_BROWSER,
    }

    private var phase = Phase.IDLE
    private var onDismiss: (() -> Unit)? = null

    /** True when this device has no Custom Tabs provider, so [open] uses `ACTION_VIEW`. */
    fun hasCustomTabsProvider(): Boolean =
        CustomTabsClient.getPackageName(activity, /* packages = */ null) != null

    @Throws(ActivityNotFoundException::class)
    fun open(url: String, onDismiss: () -> Unit) {
        val uri = Uri.parse(url)
        this.onDismiss = onDismiss
        phase = Phase.LAUNCHED
        try {
            if (hasCustomTabsProvider()) {
                CustomTabsIntent.Builder()
                    .setShowTitle(true)
                    .setUrlBarHidingEnabled(false)
                    .build()
                    .launchUrl(activity, uri)
            } else {
                activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
            }
        } catch (e: ActivityNotFoundException) {
            phase = Phase.IDLE
            this.onDismiss = null
            throw e
        }
    }

    /**
     * Bring the app back in front of the tab because the outcome already
     * arrived. A Custom Tab launches into the caller's task, so re-launching
     * this activity with CLEAR_TOP **and** SINGLE_TOP pops it: the pair is what
     * resumes the existing activity through `onNewIntent` instead of destroying
     * and recreating it, which would take the wizard with it.
     *
     * **Best effort, by the platform's rules.** Android refuses a background
     * activity start ("Background activity launch blocked", `goo.gle/android-bal`)
     * when the app has had no visible window for a while, which is exactly the
     * case when someone lingers on the sign-in page. Nothing here can change
     * that — iOS can dismiss its own sheet, Android cannot reach across to
     * Chrome's — so the server's completion page tells the person to go back to
     * FUTO Notes, and their return lands on the step the engine reports.
     * Whichever way they come back, the phase is already IDLE, so it is not
     * mistaken for a dismissal.
     */
    fun closeAndReturn() {
        if (phase == Phase.IDLE) return
        phase = Phase.IDLE
        onDismiss = null
        runCatching {
            activity.startActivity(
                Intent(activity, activity.javaClass).addFlags(
                    Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                ),
            )
        }
    }

    fun onAppPaused() {
        if (phase == Phase.LAUNCHED) phase = Phase.IN_BROWSER
    }

    /** Coming back with a tab still open means the person dismissed it. */
    fun onAppResumed() {
        if (phase != Phase.IN_BROWSER) return
        phase = Phase.IDLE
        val dismissed = onDismiss
        onDismiss = null
        dismissed?.invoke()
    }
}
