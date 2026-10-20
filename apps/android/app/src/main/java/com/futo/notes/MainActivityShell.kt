package com.futo.notes

import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.lifecycle.lifecycleScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.storage.NotesStorage
import com.futo.notes.storage.storageAdoptionMessage
import com.futo.notes.storage.StorageAdoptionSummary
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.CrashReportDialog
import com.futo.notes.ui.FeedbackScreen
import com.futo.notes.ui.navigation.AppNavigation
import com.futo.notes.ui.navigation.LicenseLandingEffect
import com.futo.notes.ui.navigation.Screen
import com.futo.notes.ui.NoteEditorScreen
import com.futo.notes.ui.NoteListScreen
import com.futo.notes.ui.SearchScreen
import com.futo.notes.ui.SettingsScreen
import com.futo.notes.ui.StorageOnboarding
import com.futo.notes.ui.SyncScreen
import com.futo.notes.ui.ThemeMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/** The normal app once the vault location is known. */
@Composable
internal fun MainActivity.AppShell(
    s: NotesStore,
    themeMode: ThemeMode,
    onThemeMode: (ThemeMode) -> Unit,
    dark: Boolean,
) {
    AppNavigation(
        hasBootstrapped = s.hasBootstrapped,
        availableFolderPaths = s.folders,
        effects = { navigator ->
            LicenseLandingEffect(license, navigator, modalUp = pendingCrashJson.value != null)
        },
    ) { screen, navigator, noteListState ->
        when (screen) {
            is Screen.Folder -> NoteListScreen(
                store = s,
                state = noteListState,
                folder = screen.path,
                onOpenNote = navigator::openNote,
                onCreate = navigator::openCreatedNote,
                onOpenFolder = navigator::openFolder,
                onFolderMoved = navigator::followFolderMove,
                onOpenSearch = navigator::openSearch,
                onOpenSettings = navigator::openSettings,
                onBack = navigator::goBack,
            )
            is Screen.Editor -> NoteEditorScreen(
                store = s,
                initialNoteId = screen.noteId,
                autoFocus = screen.autoFocus,
                darkTheme = dark,
                onBack = navigator::goBack,
                // Wikilink tap [editor.md:77]: PUSH a new editor entry so Back
                // returns to the note you came FROM (not straight to the list).
                onOpenNote = navigator::openNote,
                imagePicker = imagePicker,
            )
            is Screen.Search -> SearchScreen(
                store = s,
                onOpenNote = navigator::openNote,
                onBack = navigator::goBack,
            )
            is Screen.Settings -> SettingsScreen(
                store = s,
                sync = sync,
                license = license,
                themeMode = themeMode,
                onThemeMode = onThemeMode,
                selectedLanguageTag = appLanguage.selectedLanguageTag,
                onSelectLanguage = { languageTag -> selectLanguage(s, languageTag) },
                onOpenSync = navigator::openSync,
                onOpenFeedback = navigator::openFeedback,
                storageMode = currentMode(),
                onChangeStorage = navigator::openStorageLocation,
                onBack = navigator::goBack,
            )
            // Settings -> Storage location. A screen, not an overlay: Back and
            // Cancel are the same pop, and the Settings entry stays underneath
            // it (github#28). Confirming migrates + restarts.
            is Screen.StorageLocation -> StorageOnboarding(
                initialMode = currentMode(),
                deviceModeSupported = NotesStorage.deviceModeSupported(),
                onConfirm = {
                    navigator.goBack()
                    performStorageChange(it)
                },
                onCancel = navigator::goBack,
            )
            is Screen.Sync -> SyncScreen(
                store = s,
                sync = sync,
                secure = secure,
                onBack = navigator::goBack,
            )
            is Screen.Feedback -> FeedbackScreen(
                picker = imagePicker,
                onBack = navigator::goBack,
                onSent = navigator::goBack,
            )
        }
    }

    // Crash Report dialog [app.md:61]: shown when the startup scan found
    // reports and always-send is off. "Don't Send" is the desktop-parity
    // permanent opt-out.
    pendingCrashJson.value?.let { json ->
        CrashReportDialog(
            reportJson = json,
            onSend = { userNote, alwaysSend ->
                pendingCrashJson.value = null
                if (alwaysSend) prefs.edit().putBoolean(Prefs.CRASH_ALWAYS_SEND, true).apply()
                lifecycleScope.launch(Dispatchers.IO) {
                    CrashReporter.sendAll(notesRoot, userNote)
                }
            },
            onDontSend = {
                pendingCrashJson.value = null
                prefs.edit().putBoolean(Prefs.CRASH_ENABLED, false).apply()
                lifecycleScope.launch(Dispatchers.IO) {
                    CrashReporter.discardAll(notesRoot)
                }
            },
        )
    }

    // The target folder already has notes, so the switch opens it instead of
    // copying. Both folders are named with what they hold so the user can
    // tell a current vault from a leftover one before committing.
    pendingStorageAdoption.value?.let { adoption ->
        val currentLocalization = LocalLocalization.current
        val adoptionMessage = storageAdoptionMessage(
            StorageAdoptionSummary(
                destinationNotes = adoption.plan.notes,
                destinationLastModifiedMillis = adoption.plan.lastModifiedMs,
                currentPath = notesRoot.path,
                currentNotes = store.value?.notes?.size ?: 0,
                currentTimeMillis = System.currentTimeMillis(),
            ),
            currentLocalization::localizedRelativeTime,
        )
        ConfirmDialog(
            title = currentLocalization.localizedText("storage.android.openExistingHeading"),
            body = currentLocalization.localizedText(
                adoptionMessage.path,
                adoptionMessage.arguments,
            ),
            confirmLabel = currentLocalization.localizedText("storage.android.openExistingAction"),
            onConfirm = {
                pendingStorageAdoption.value = null
                adoptExistingStorage(adoption)
            },
            onDismiss = { pendingStorageAdoption.value = null },
        )
    }
}
