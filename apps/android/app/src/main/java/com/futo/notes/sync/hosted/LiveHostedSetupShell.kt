package com.futo.notes.sync.hosted

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import com.futo.notes.SecureStore
import com.futo.notes.SyncManager
import com.futo.notes.localization.Localization
import com.futo.notes.localization.LocalizedMessage
import uniffi.futo_notes_ffi.HostedSetupClient

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

    /**
     * What this phone calls itself, for the other device's confirmation dialog.
     *
     * `Settings.Global.DEVICE_NAME` is the name a person actually set (About
     * phone → Device name); it is unset on plenty of devices, and reading it is
     * best-effort — a locked-down ROM can refuse — so the model name is the
     * fallback. Either is an honest answer, and neither is worth a crash.
     */
    override fun deviceName(): String {
        val chosen = try {
            Settings.Global.getString(activity.contentResolver, Settings.Global.DEVICE_NAME)
        } catch (_: SecurityException) {
            null
        }
        return chosen?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }

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
 * Keystore entries, a Custom Tab, and the app's one [SyncManager] for the two
 * things that are sessions rather than screens — starting one when the wizard
 * finishes, and revoking the live one on sign out.
 */
fun liveHostedSetupModel(
    notesRoot: String,
    secure: SecureStore,
    shell: LiveHostedSetupShell,
    sync: SyncManager,
): HostedSetupModel = HostedSetupModel(
    makeSetup = { HostedSetupClient.hosted(KeystoreVaultSecretStore(secure, notesRoot)) },
    shell = shell,
    // Through the manager, so Rust revokes the session that is actually
    // running: handed a throwaway client, `stopLive` would leave the live loop
    // alive after the session it belongs to was gone.
    signOutEffect = { setup -> sync.signOutHosted(notesRoot, setup) },
    connectEffect = { setup -> sync.connectHosted(notesRoot, setup) },
)
