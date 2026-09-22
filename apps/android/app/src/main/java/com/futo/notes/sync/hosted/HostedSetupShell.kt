package com.futo.notes.sync.hosted

import com.futo.notes.localization.LocalizedMessage

/**
 * The things the hosted wizard needs from the shell, because Rust cannot do
 * them: put a URL in a browser tab over the app, bring the app back in front of
 * that tab, put a recovery key on the clipboard or into the system share sheet,
 * and say what this device is called (ADR 0003, decision 11).
 *
 * `announce` is how the wizard says something happened without owning a piece
 * of chrome — on Android, a toast.
 *
 * [openAuthTab] reports the person coming back from the browser through
 * `onDismiss`, which is what cancels the wait and leaves the screen exactly
 * where it was.
 *
 * [deviceName] is what the pairing code carries and what the other device's
 * confirmation dialog names. The engine has no way to know it, and neither does
 * a composable — only the platform does.
 */
interface HostedSetupShell {
    fun deviceName(): String

    fun openAuthTab(url: String, onDismiss: () -> Unit)

    /** Take the browser tab down because the outcome already arrived. */
    fun closeAuthTab()

    fun copyToClipboard(text: String)

    /** Hand the recovery key to the system share sheet. */
    fun share(text: String)

    fun announce(message: LocalizedMessage)
}
