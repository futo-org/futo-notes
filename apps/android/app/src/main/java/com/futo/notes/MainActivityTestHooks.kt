package com.futo.notes

import android.content.Intent
import android.provider.Settings
import com.futo.notes.storage.StorageMode
import com.futo.notes.testhook.TestHooks
import com.futo.notes.ui.currentAttachment
import com.futo.notes.ui.EditorHost
import com.futo.notes.ui.focusEditor

// ── Automation hooks (debug builds only) ──

/**
 * What a harness or an interactive session can ask this activity to do, by
 * name. Hooks call the same entry points the UI calls, so what they replace is
 * the tapping, not the code under test; `TestHooks` compiles to nothing in a
 * release build. Field names in `state` are read by
 * `tests/lib/android/testHooks.mjs`.
 */
internal fun MainActivity.testHooks(): Map<String, (Intent) -> Map<String, Any?>?> = mapOf(
    // Every field here replaces an accessibility-tree read, which costs ~2s and
    // reports whatever Compose last managed to render rather than app state
    // (AGENTS.md M21).
    "state" to {
        mapOf(
            "storageMode" to currentMode().name,
            "vaultPath" to if (isNotesRootInitialized()) notesRoot.path else null,
            "notes" to (store.value?.notes?.size ?: 0),
            // First-run only. The Settings change-location picker is an
            // ordinary screen now, so it is observed by its own label.
            "onboarding" to showOnboarding.value,
            "movingNotes" to storageSwitching.value,
            "awaitingStorageConfirmation" to (pendingStorageAdoption.value != null),
            "shellVisible" to (store.value != null && !storageSwitching.value),
            // The License row's state, read from the app rather than from
            // an accessibility dump (M21): "LOADING" until the stored pair
            // has been read off IO, then Rust's verdict.
            "license" to (license.view?.status?.name ?: "LOADING"),
        )
    },
    "storage-mode" to { intent ->
        val requested = intent.getStringExtra("mode").orEmpty()
        // Throwing is the contract for a bad argument: the ack carries the
        // reason, where a silent no-op would look like a hung switch.
        performStorageChange(
            runCatching { StorageMode.valueOf(requested) }.getOrElse {
                error("no such storage mode: $requested")
            },
        )
        null
    },
    "confirm-storage" to {
        val adoption = checkNotNull(pendingStorageAdoption.value) {
            "no storage switch is awaiting confirmation"
        }
        pendingStorageAdoption.value = null
        adoptExistingStorage(adoption)
        null
    },
    // Focusing the editor is native focus + DOM focus, in that order
    // (EditorWebView.focusEditor) — evaluating `FutoEditor.focus()` from
    // outside the app does only the DOM half, which Chromium then withholds
    // because the document itself is unfocused, so `.cm-focused` never
    // appears. This hook calls the SAME entry point the quick-capture open
    // uses, so a harness's focus is a user's focus.
    "focus-editor" to {
        val editorHost = EditorHost.get(this)
        // Throwing is the contract for a hook that cannot mean anything yet:
        // with no editor attached, focusing would be a silent no-op that
        // looks exactly like a hung open.
        checkNotNull(editorHost.currentAttachment()) { "no note is open in the editor" }
        editorHost.focusEditor()
        null
    },
)
