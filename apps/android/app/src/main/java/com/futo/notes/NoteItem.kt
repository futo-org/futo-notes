package com.futo.notes

/** A single note for the UI. Mirrors the iOS `NoteItem`; `tags` are canonical
 *  lowercase names WITHOUT the leading `#`. */
data class NoteItem(
    val id: String,
    val title: String,
    val folder: String,
    val modifiedMs: Long,
    /** Single-line preview (search filtering). */
    val preview: String,
    /** Multi-line, display-oriented preview: block markdown rewritten for
     *  rendering (☐/☑ task glyphs, • bullets, tables dropped, inline emphasis
     *  kept, line breaks preserved). Rendered as an AnnotatedString in the list.
     *  See `make_rich_preview` in futo-notes-model. */
    val richPreview: String,
    val tags: List<String>,
)

/**
 * The immediate child folders of [of] ("" = the vault root), derived from the
 * engine's FLAT list of full folder paths by one prefix filter — the Android
 * twin of iOS `NotesStore.subfolders(of:)`. Pure + top-level so the folder-list
 * derivation is unit-testable without an FFI handle.
 *
 * No sorting happens here: `folders` arrives from a Rust `BTreeSet`, so it is
 * already alphabetical and every ancestor path is present (a `"A/B"` entry is
 * always accompanied by `"A"`), which is what makes every folder reachable by
 * tapping down one level at a time.
 */
internal fun immediateSubfolders(folders: List<String>, of: String): List<String> {
    val prefix = if (of.isEmpty()) "" else "$of/"
    return folders.filter { path ->
        path.startsWith(prefix) &&
            path.drop(prefix.length).let { it.isNotEmpty() && !it.contains('/') }
    }
}
