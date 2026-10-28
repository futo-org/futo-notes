package com.futo.notes.puppet

import com.futo.notes.NoteItem

/**
 * A list row's test tag, which is also how the agent names it: `/tree` reports it as the
 * node's `id`, and OpenNote, OpenFolder and ScrollToRow match a row by it.
 */
internal fun noteRowTag(noteId: String) = "note:$noteId"

internal fun folderRowTag(path: String) = "folder:$path"

/**
 * Why the note or folder behind [tag] has no row among [rows] (the tags the list on screen
 * shows), or null when it has one. A note or folder the vault does not have is a bad argument
 * in the words every app uses, which futo-puppet answers with the ids it may have meant; one
 * elsewhere is futo-puppet's to reach (crates/futo-puppet/src/screen/row_verbs.rs).
 */
internal fun rowRefusal(tag: String, rows: List<String>, notes: List<NoteItem>, folders: List<String>): PuppetVerbRefusal? {
    if (tag in rows) return null
    val name = tag.substringAfter(':')
    val isNote = tag.startsWith("note:")
    val known = if (isNote) notes.any { it.id == name } else name in folders
    if (!known) return PuppetVerbRefusal(400, "no such ${if (isNote) "note" else "folder"}: $name")
    return PuppetVerbRefusal(409, "`$name` has no row on this screen")
}
