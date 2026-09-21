package com.futo.notes.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The new-folder / rename-folder dialog's live verdict [list.md]. The
 * `issueKinds` here are what the canonical Rust `validateTitle` reports for the
 * raw input, and `clean` is its `sanitizeTitle` — the shell never re-derives
 * either rule (M6).
 */
class FolderNameVerdictTest {
    @Test
    fun `a forbidden character is named, not silently stripped`() {
        // Regression: `QA Folder/Bad` left Create enabled and created
        // `QA FolderBad` with no message at all.
        val verdict = folderNameVerdict(
            raw = "QA Folder/Bad",
            clean = "QA FolderBad",
            issueKinds = listOf("forbidden_chars"),
            duplicate = false,
        )

        assertFalse(verdict.canConfirm)
        assertEquals("folders.validation.forbiddenCharacter", verdict.error?.path)
    }

    @Test
    fun `a forbidden character outranks the collision its sanitized form would hit`() {
        val verdict = folderNameVerdict(
            raw = "QA Folder/Bad",
            clean = "QA FolderBad",
            issueKinds = listOf("forbidden_chars"),
            duplicate = true,
        )

        assertFalse(verdict.canConfirm)
        assertEquals("folders.validation.forbiddenCharacter", verdict.error?.path)
    }

    @Test
    fun `a clean name confirms with no message`() {
        val verdict = folderNameVerdict(
            raw = "QA Folder",
            clean = "QA Folder",
            issueKinds = emptyList(),
            duplicate = false,
        )

        assertTrue(verdict.canConfirm)
        assertNull(verdict.error)
    }

    @Test
    fun `a case-insensitive duplicate sibling is blocked and named`() {
        val verdict = folderNameVerdict(
            raw = "Archive",
            clean = "Archive",
            issueKinds = emptyList(),
            duplicate = true,
        )

        assertFalse(verdict.canConfirm)
        assertEquals("folders.duplicateName", verdict.error?.path)
    }

    @Test
    fun `a name that sanitizes away entirely is invalid`() {
        val verdict = folderNameVerdict(
            raw = "...",
            clean = "Untitled",
            issueKinds = listOf("leading_dots", "trailing_dots"),
            duplicate = false,
        )

        assertFalse(verdict.canConfirm)
        assertEquals("folders.invalidName", verdict.error?.path)
    }

    @Test
    fun `literally typing Untitled is allowed`() {
        val verdict = folderNameVerdict(
            raw = "Untitled",
            clean = "Untitled",
            issueKinds = emptyList(),
            duplicate = false,
        )

        assertTrue(verdict.canConfirm)
        assertNull(verdict.error)
    }

    @Test
    fun `an empty field stays disabled but quiet`() {
        // Even when an "Untitled" folder exists: sanitizeTitle("") is
        // "Untitled", and the collision it would name is not the user's doing.
        val verdict = folderNameVerdict(
            raw = "",
            clean = "Untitled",
            issueKinds = listOf("empty"),
            duplicate = true,
        )

        assertFalse(verdict.canConfirm)
        assertNull(verdict.error)
    }
}
