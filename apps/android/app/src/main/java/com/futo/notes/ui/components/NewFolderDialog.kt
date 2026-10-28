package com.futo.notes.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import org.json.JSONObject
import uniffi.futo_notes_ffi.sanitizeTitle
import uniffi.futo_notes_ffi.validateTitle

/**
 * Name dialog for a new folder under [parent] ("" = root) [list.md]. The
 * name is sanitized by the SAME Rust filename rules as a note title (a folder
 * name is a path segment); empty names, case-insensitive-duplicate siblings and
 * names carrying a forbidden character can't be created — [folderNameVerdict]
 * owns that decision and its wording. Confirm hands back the FULL folder path.
 * [renaming] makes it the rename dialog, whose verbs are SetNewName and SubmitRename.
 */
@Composable
fun NewFolderDialog(
    parent: String,
    store: NotesStore,
    onCreate: (path: String) -> Unit,
    onDismiss: () -> Unit,
    initialName: String = "",
    title: String? = null,
    confirmLabel: String? = null,
    excludePath: String? = null,
    renaming: Boolean = false,
) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    // Read here (activity window) — the dialog window's insets lie (github#23).
    val imeVisible = imeTargetVisible()
    var name by remember(initialName) { mutableStateOf(initialName) }

    /** The folder name [typed] makes and what the dialog says of it. */
    fun check(typed: String): Pair<String, FolderNameVerdict> {
        val raw = typed.trim()
        val clean = sanitizeTitle(raw)
        val duplicate = clean.isNotEmpty() && store.subfolders(parent)
            .filter { it != excludePath }
            .any { it.substringAfterLast('/').equals(clean, ignoreCase = true) }
        // The verdict comes from the canonical Rust rules, never a Kotlin copy of
        // them (M6): sanitizeTitle above, and validateTitle's issue kinds here.
        return clean to folderNameVerdict(
            raw = raw,
            clean = clean,
            issueKinds = validateTitle(raw).map { it.kind },
            duplicate = duplicate,
        )
    }
    val (clean, verdict) = check(name)

    fun type(typed: String) {
        name = typed.replace("\n", "")
    }

    fun confirm(folderName: String) = onCreate(if (parent.isEmpty()) folderName else "$parent/$folderName")

    // The field, Confirm and Cancel. Confirm reads the name as it is now, not as this
    // frame drew it, so a verb straight after SetNewFolderName sees what it typed.
    PuppetVerbScope(modal = true) {
        val setName: suspend (JSONObject) -> Any? = { arguments ->
            type(arguments.getString("name"))
            mapOf("name" to name)
        }
        val submit: suspend (JSONObject) -> Unit = {
            val (folderName, verdictNow) = check(name)
            if (!verdictNow.canConfirm) {
                // What the dialog shows under the field; an empty field shows nothing.
                throw PuppetVerbRefusal(
                    409,
                    verdictNow.error?.let { localization.localizedText(it.path, it.arguments) }
                        ?: "the name is empty, so ${if (renaming) "Rename" else "Create"} is disabled",
                )
            }
            confirm(folderName)
        }
        listOf(
            if (renaming) {
                PuppetVerb("SetNewName", required = listOf("name"), controls = listOf("folders.nameFieldShort"), run = setName)
            } else {
                PuppetVerb("SetNewFolderName", required = listOf("name"), controls = listOf("folders.nameFieldShort"), run = setName)
            },
            if (renaming) {
                PuppetVerb("SubmitRename", controls = listOf("common.actions.rename"), run = submit)
            } else {
                PuppetVerb("SubmitNewFolder", controls = listOf("common.actions.create"), run = submit)
            },
            PuppetVerb("DismissDialog", controls = listOf("common.actions.cancel")) {
                onDismiss()
            },
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = c.surface,
        title = {
            Text(
                title ?: localization.localizedText("folders.createHeading"),
                style = FutoType.title,
                color = c.textPrimary,
            )
        },
        text = {
            Column {
                // The dialog is its own window — the app-root install (#24)
                // can't reach its focus manager.
                ClearFocusOnImeDismiss(imeVisible)
                OutlinedTextField(
                    value = name,
                    onValueChange = { type(it) },
                    label = { Text(localization.localizedText("folders.nameFieldShort")) },
                    singleLine = true,
                    shape = RoundedCornerShape(FutoRadius.md),
                    modifier = Modifier.fillMaxWidth(),
                )
                verdict.error?.let { error ->
                    Text(
                        localization.localizedText(error.path, error.arguments),
                        style = FutoType.caption,
                        color = c.danger,
                        modifier = Modifier.padding(top = 6.dp),
                    )
                }
            }
        },
        confirmButton = {
            // Disabled visual must match the disabled behavior [list.md]: a
            // hardcoded accent color would override TextButton's disabled
            // content color and make an inert Create look tappable.
            val canCreate = verdict.canConfirm
            TextButton(
                enabled = canCreate,
                onClick = { confirm(clean) },
            ) {
                Text(
                    confirmLabel ?: localization.localizedText("common.actions.create"),
                    color = if (canCreate) c.textAccent else c.textMuted,
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(localization.localizedText("common.actions.cancel"), color = c.textSecondary)
            }
        },
    )
}

/**
 * What the dialog shows and whether Confirm is live, for a typed folder name
 * [list.md]. All three inputs beyond [duplicate] come from the shared
 * rules: [clean] is Rust `sanitizeTitle(raw)` and [issueKinds] the `kind`s of
 * Rust `validateTitle(raw)` — the character rules live there, not here (M6).
 *
 * A forbidden character used to pass every gate whenever the name still
 * sanitized to something non-empty, so `QA Folder/Bad` silently created
 * `QA FolderBad`; the character is now named, ahead of the collision its
 * sanitized form would hit (desktop's `validateNewFolderName` orders it the
 * same way). An empty field stays disabled but quiet.
 */
internal fun folderNameVerdict(
    raw: String,
    clean: String,
    issueKinds: List<String>,
    duplicate: Boolean,
): FolderNameVerdict {
    val forbidden = issueKinds.contains("forbidden_chars")
    // sanitizeTitle falls back to "Untitled" when the input strips to nothing
    // (its note-title contract: "", "///", "..."). Creating then would
    // silently make a folder the user never named (2026-07-02 QA) — treat it
    // as invalid. Literally typing "Untitled" stays allowed.
    val sanitizesAway = clean == "Untitled" && raw != "Untitled"
    return FolderNameVerdict(
        canConfirm = clean.isNotEmpty() && !forbidden && !duplicate && !sanitizesAway,
        error = when {
            raw.isEmpty() -> null
            forbidden -> LocalizedMessage("folders.validation.forbiddenCharacter")
            duplicate -> LocalizedMessage("folders.duplicateName")
            sanitizesAway -> LocalizedMessage("folders.invalidName")
            else -> null
        },
    )
}

/** [folderNameVerdict]'s outcome: the Confirm state and the message beside the field. */
internal data class FolderNameVerdict(
    val canConfirm: Boolean,
    val error: LocalizedMessage?,
)

/**
 * `OpenCreateFolderDialog {name?}`'s shortcut: naming the folder and pressing Create, the two
 * steps the dialog's own verbs take.
 */
internal val createFolderShortcut = mapOf(
    "name" to listOf("SetNewFolderName" to mapOf("name" to "\$"), "SubmitNewFolder" to emptyMap()),
)

/** `RenameFolder {name?}`'s shortcut: the rename dialog's name, then its Rename. */
internal val renameFolderShortcut = mapOf(
    "name" to listOf("SetNewName" to mapOf("name" to "\$"), "SubmitRename" to emptyMap()),
)
