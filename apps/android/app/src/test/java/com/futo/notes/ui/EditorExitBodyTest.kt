package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * What an exit commits when the editor could not hand back its document — i.e.
 * whether the user can leave the screen at all.
 *
 * 2026-09-01: opening a 50,000-line note with no blank line anywhere blocks the
 * WebView renderer's JS thread for minutes, so `evaluateJavascript` never calls
 * back. Because the shell read "could not read the editor" as "refuse the
 * exit", the body stayed blank and every Back tap answered "Couldn't save note.
 * Your changes are still pending." — force-quit and Delete Note were the only
 * ways out. The rule below is the same one iOS states in `editorExitBody`
 * (docs/spec/editor.md, "Editor exits").
 */
class EditorExitBodyTest {
    @Test
    fun `a captured document is the body, whatever the shell was holding`() {
        assertEquals("live", editorExitBody(EditorCaptureOutcome.Captured("live"), "stale"))
    }

    @Test
    fun `an empty capture is a real answer, not a missing one`() {
        // A note whose body the user just cleared. Falling back to the shell's
        // copy here would resurrect the deleted text on the next save.
        assertEquals("", editorExitBody(EditorCaptureOutcome.Captured(""), "old text"))
    }

    @Test
    fun `no live document leaves with the shell's own copy, so the user is never trapped`() {
        // The editor never presented a document, so it cannot be holding an
        // edit; the shell's copy is the freshest body in existence.
        assertEquals(
            "from disk",
            editorExitBody(EditorCaptureOutcome.NoLiveDocument, "from disk"),
        )
    }

    @Test
    fun `no live document and an unread note commits nothing - the load is abandoned`() {
        // The shape of the reported bug: the note never opened, so the shell's
        // copy still equals what is on disk. commitEditorNavigationSnapshot's
        // own `content == savedContent` guard then turns this into a no-op
        // write, which is exactly "abandon the load rather than save a prefix".
        val onDisk = "the whole 50,000-line note"
        val body = editorExitBody(EditorCaptureOutcome.NoLiveDocument, onDisk)
        assertEquals(onDisk, body)
        val commit = kotlinx.coroutines.runBlocking {
            commitEditorNavigationSnapshot(
                savedContent = onDisk,
                content = checkNotNull(body),
                flush = { _, _ -> error("an unread note must not be written back") },
            )
        }
        assertEquals(true, commit.canNavigate)
        assertNull(commit.disposition)
    }

    @Test
    fun `a capture belonging to another note refuses the exit`() {
        // The one genuinely ambiguous case, and the only one that still reports
        // a capture failure: reading would answer for the wrong document.
        assertNull(editorExitBody(EditorCaptureOutcome.NotOurs, "ours"))
    }
}
