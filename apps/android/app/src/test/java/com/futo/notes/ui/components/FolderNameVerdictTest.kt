package com.futo.notes.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The new-folder / rename-folder dialog's live verdict [list.md]. The
 * `issueKinds` here are what the canonical Rust `validateTitle` reports for the
 * raw input, and `clean` is its `sanitizeTitle` — the shell never re-derives
 * either rule (M6).
 */
class FolderNameVerdictTest {
    private data class Case(
        val name: String,
        val raw: String,
        val clean: String,
        val issueKinds: List<String>,
        val duplicate: Boolean,
        val canConfirm: Boolean,
        val errorPath: String?,
    )

    @Test
    fun `folder name verdict matches each case`() {
        val forbidden = "folders.validation.forbiddenCharacter"
        listOf(
            // Regression: `QA Folder/Bad` left Create enabled and created
            // `QA FolderBad` with no message at all.
            Case(
                "a forbidden character is named",
                raw = "QA Folder/Bad", clean = "QA FolderBad", issueKinds = listOf("forbidden_chars"), duplicate = false,
                canConfirm = false, errorPath = forbidden,
            ),
            Case(
                "a forbidden character outranks the collision its sanitized form would hit",
                raw = "QA Folder/Bad", clean = "QA FolderBad", issueKinds = listOf("forbidden_chars"), duplicate = true,
                canConfirm = false, errorPath = forbidden,
            ),
            Case(
                "a clean name confirms with no message",
                raw = "QA Folder", clean = "QA Folder", issueKinds = emptyList(), duplicate = false,
                canConfirm = true, errorPath = null,
            ),
            Case(
                "a case-insensitive duplicate sibling is blocked and named",
                raw = "Archive", clean = "Archive", issueKinds = emptyList(), duplicate = true,
                canConfirm = false, errorPath = "folders.duplicateName",
            ),
            Case(
                "a name that sanitizes away entirely is invalid",
                raw = "...", clean = "Untitled", issueKinds = listOf("leading_dots", "trailing_dots"), duplicate = false,
                canConfirm = false, errorPath = "folders.invalidName",
            ),
            Case(
                "literally typing Untitled is allowed",
                raw = "Untitled", clean = "Untitled", issueKinds = emptyList(), duplicate = false,
                canConfirm = true, errorPath = null,
            ),
            // Even when an "Untitled" folder exists: sanitizeTitle("") is
            // "Untitled", and the collision it would name is not the user's doing.
            Case(
                "an empty field stays disabled but quiet",
                raw = "", clean = "Untitled", issueKinds = listOf("empty"), duplicate = true,
                canConfirm = false, errorPath = null,
            ),
        ).forEach { case ->
            val verdict = folderNameVerdict(
                raw = case.raw,
                clean = case.clean,
                issueKinds = case.issueKinds,
                duplicate = case.duplicate,
            )

            assertEquals(case.name, case.canConfirm, verdict.canConfirm)
            assertEquals(case.name, case.errorPath, verdict.error?.path)
        }
    }
}
