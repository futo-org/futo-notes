package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteShareTest {
    @Test
    fun smallNoteSharesInline() {
        assertTrue(NoteShare.sharesInline("# Groceries\n\nmilk\n"))
        assertTrue(NoteShare.sharesInline("a".repeat(NoteShare.MAX_INLINE_BYTES)))
    }

    @Test
    fun bigNoteGoesOutAsAFile() {
        // The crash #1812 shape: a body past the Binder transaction limit.
        assertFalse(NoteShare.sharesInline("a".repeat(NoteShare.MAX_INLINE_BYTES + 1)))
        assertFalse(NoteShare.sharesInline("Lorem ipsum\n".repeat(200_000)))
    }

    @Test
    fun inlineLimitCountsUtf8BytesNotChars() {
        // 3 bytes per char: under the limit by length, over it on the wire.
        assertFalse(NoteShare.sharesInline("中".repeat(NoteShare.MAX_INLINE_BYTES / 2)))
    }

    @Test
    fun fileNameKeepsTheTitleAndDropsPathHostileCharacters() {
        assertEquals("Groceries.md", NoteShare.fileName("Groceries"))
        assertEquals("ab.md", NoteShare.fileName("a/b"))
        assertEquals("note.md", NoteShare.fileName(""))
        assertEquals("note.md", NoteShare.fileName(" ../ "))
    }
}
