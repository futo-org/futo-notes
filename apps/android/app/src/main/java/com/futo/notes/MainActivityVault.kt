package com.futo.notes

import androidx.activity.compose.setContent
import androidx.lifecycle.lifecycleScope
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.StorageMode
import com.futo.notes.ui.showToast
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun MainActivity.selectLanguage(store: NotesStore, languageTag: String?) {
    lifecycleScope.launch {
        if (store.settlePendingEditorDrafts()) {
            appLanguage.select(languageTag)
        } else {
            showToast(
                this@selectLanguage,
                localization.localizedText("settings.language.android.draftSaveFailed"),
                long = true,
            )
        }
    }
}

/**
 * No shell to land in: the first-run storage choice, a lost grant, or a
 * failed recovery. A shell that is still loading is not this.
 */
internal fun MainActivity.hasNoShell(): Boolean =
    showOnboarding.value || showRegrant.value || storageRecoveryFailure.value != null

/**
 * Build the vault-dependent objects for [root] — mirrors what onCreate used
 * to do inline. Touches no disk on the main thread: `NotesStore` is lazy +
 * scans off-main, and search/crash scans run on IO. Makes `store` non-null,
 * which flips setContent from the picker to the shell.
 */
internal fun MainActivity.initVault(root: File) {
    notesRoot = root

    // Crash pipeline [app.md:61]: persist uncaught exceptions to
    // <vault>/.crashlogs on the way down (then chain to the platform handler);
    // the scan below offers them for upload.
    CrashReporter.install(root, BuildConfig.VERSION_NAME)

    val s = NotesStore(root, File(filesDir, "search"), NoteSortPreference.read(prefs))
    sync = SyncManager(secure, prefs)
    // Sync writes bypass local mutations, so project the engine-reported
    // affected rows and deliver the same summary to an open editor.
    sync.onLocalTreeChanged = { summary -> s.localTreeChanged(summary) }
    // Auto-push local edits: every NotesStore mutation signals the live loop,
    // which debounces and pushes to peers (no-op when not connected).
    s.onLocalChange = { sync.noteChanged() }
    s.onSortOrderChanged = { order -> NoteSortPreference.write(prefs, order) }

    // Silent sync-session restore [sync.md:91] — off-main, fire-and-forget,
    // never gates render. No-op when no password is stored.
    sync.restoreSession(s.rootPath)

    // Crash-log scan [settings.md:43] — backgrounded, never gates render.
    lifecycleScope.launch(Dispatchers.IO) {
        val pending = CrashReporter.pending(root)
        if (pending.isEmpty()) return@launch
        if (!prefs.getBoolean(Prefs.CRASH_ENABLED, true)) return@launch
        if (prefs.getBoolean(Prefs.CRASH_ALWAYS_SEND, false)) {
            CrashReporter.sendAll(root, null)
        } else {
            val json = pending.joinToString("\n\n") { f ->
                runCatching { f.readText() }.getOrDefault("")
            }.trim()
            if (json.isNotEmpty()) {
                withContext(Dispatchers.Main) { pendingCrashJson.value = json }
            }
        }
    }

    store.value = s
}

// ── Storage-mode flows ──

internal fun MainActivity.currentMode(): StorageMode =
    runCatching { StorageMode.valueOf(prefs.getString(Prefs.STORAGE_MODE, null) ?: "") }
        .getOrDefault(StorageMode.APP)

/** First-run picker confirm: DEVICE goes through the permission grant first. */
internal fun MainActivity.chooseStorage(mode: StorageMode) {
    if (mode == StorageMode.DEVICE) requestDeviceAccess { finalizeFreshChoice(StorageMode.DEVICE) }
    else finalizeFreshChoice(mode)
}

internal fun MainActivity.finalizeFreshChoice(mode: StorageMode) {
    prefs.edit().putString(Prefs.STORAGE_MODE, mode.name).apply()
    showOnboarding.value = false
    initVault(NotesStorage.rootFor(this, mode, BuildConfig.DEBUG))
}
