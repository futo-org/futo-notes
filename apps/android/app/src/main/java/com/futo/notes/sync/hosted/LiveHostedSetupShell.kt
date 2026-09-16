package com.futo.notes.sync.hosted

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.widget.Toast
import com.futo.notes.SecureStore
import com.futo.notes.localization.Localization
import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.HostedSetupClient
import uniffi.futo_notes_ffi.SyncClient
import uniffi.futo_notes_ffi.hostedServerUrl

/**
 * The live wiring behind the hosted wizard: the Custom Tab, the clipboard, the
 * system share sheet, and a toast. Every one of these is a thing Rust cannot
 * do; nothing here decides anything.
 */
class LiveHostedSetupShell(
    private val activity: Activity,
    /**
     * Read per call, not held: the app's language can change while this screen
     * is up, and the model keeps this shell for the screen's whole life.
     */
    private val localization: () -> Localization,
) : HostedSetupShell {
    private val tab = CustomTabsAuthSheet(activity)

    override fun openAuthTab(url: String, onDismiss: () -> Unit) = tab.open(url, onDismiss)

    override fun closeAuthTab() = tab.closeAndReturn()

    override fun copyToClipboard(text: String) {
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText(shareLabel(), text))
    }

    override fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            // The key and nothing else, so what gets shared pastes straight
            // back into the unlock field.
            putExtra(Intent.EXTRA_TEXT, text)
        }
        activity.startActivity(Intent.createChooser(send, shareLabel()))
    }

    override fun announce(message: LocalizedMessage) {
        Toast.makeText(
            activity,
            localization().localizedText(message.path, message.arguments),
            Toast.LENGTH_SHORT,
        ).show()
    }

    /** What the clipboard entry and the share chooser are called. */
    private fun shareLabel(): String =
        localization().localizedText("sync.hosted.recoveryKey.accessibilityLabel")

    /** Forwarded from the composable's lifecycle observer. */
    fun onAppPaused() = tab.onAppPaused()

    fun onAppResumed() = tab.onAppResumed()
}

/**
 * The wizard as the app runs it: Rust's state machine over this vault's
 * Keystore entries, a Custom Tab, and a handle on the same vault for sign out
 * to demote through.
 */
fun liveHostedSetupModel(
    notesRoot: String,
    secure: SecureStore,
    shell: LiveHostedSetupShell,
): HostedSetupModel = HostedSetupModel(
    makeSetup = { HostedSetupClient.hosted(KeystoreVaultSecretStore(secure, notesRoot)) },
    shell = shell,
    // Hosted sync does not run a session yet (futo-notes#186), so there is no
    // live hosted client to reuse; `signOut` only needs a handle on the vault
    // to demote what is on disk, exactly as disconnect does.
    signOutEffect = { setup -> setup.signOut(SyncClient(notesRoot, hostedServerUrl())) },
)
