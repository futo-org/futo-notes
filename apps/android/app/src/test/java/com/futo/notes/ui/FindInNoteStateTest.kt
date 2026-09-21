package com.futo.notes.ui

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FindInNoteStateTest {
    private fun noteEditorSource(): String {
        val candidates = listOf(
            File("src/main/java/com/futo/notes/ui/NoteEditorScreen.kt"),
            File("app/src/main/java/com/futo/notes/ui/NoteEditorScreen.kt"),
            File("apps/android/app/src/main/java/com/futo/notes/ui/NoteEditorScreen.kt"),
        )
        return candidates.firstOrNull(File::isFile)?.readText()
            ?: error("could not locate NoteEditorScreen.kt from cwd=${File(".").absolutePath}")
    }

    @Test
    fun `back dismisses find before exiting the note`() {
        assertEquals(FindBackAction.DismissFind, findBackAction(true))
        assertEquals(FindBackAction.ExitNote, findBackAction(false))
    }

    @Test
    fun `saved state is current only in the same app process`() {
        assertEquals(true, isFindStateCurrent("process-a", "process-a"))
        assertEquals(false, isFindStateCurrent("process-a", "process-b"))
    }

    @Test
    fun `match navigation is disabled when there are no results`() {
        assertFalse(canStepFind(0))
        assertTrue(canStepFind(1))
    }

    @Test
    fun `bridge report preserves engine values verbatim`() {
        val report = decodeFindMatches(
            JSONObject().apply {
                put("query", "needle")
                put("current", 2)
                put("total", 4)
                put("label", "2 of 4")
            },
        )

        assertEquals(FindMatchesReport("needle", 2, 4, "2 of 4"), report)
    }

    @Test
    fun `incomplete bridge report is rejected`() {
        assertNull(decodeFindMatches(JSONObject().put("query", "needle")))
    }

    @Test
    fun `stale query echo cannot replace newer native input`() {
        val gate = FindReportGate()
        val old = FindMatchesReport("nee", 1, 1, "1 of 1")
        val current = FindMatchesReport("needle", 1, 1, "1 of 1")

        assertFalse(gate.accepts(old))
        gate.opened()
        assertTrue(gate.accepts(old))
        gate.queryChanged("needle")
        assertFalse(gate.accepts(old))
        assertTrue(gate.accepts(current))
        gate.closed()
        assertFalse(gate.accepts(current))
    }

    @Test
    fun `find report stays with the attachment that posted it`() {
        val first = EditorAttachmentToken(1)
        val second = EditorAttachmentToken(2)

        assertTrue(isCurrentFindReportOwner(1, first))
        assertFalse(isCurrentFindReportOwner(1, second))
        assertFalse(isCurrentFindReportOwner(1, null))
    }

    @Test
    fun `toolbar navigation closes find before the shared editor detaches`() {
        val navigation = noteEditorSource()
            .substringAfter("fun navigateAfterSaving")
            .substringBefore("fun saveImageForAttachment")
        val prepare = navigation
            .substringAfter("override fun prepare()")
            .substringBefore("override suspend fun cancelPendingSave")

        assertTrue(prepare.indexOf("dismissFind()") in 0 until prepare.indexOf("host.blur()"))
    }

    /**
     * The query field is a native EditText, and Android leaves the IME shown
     * when the view that owns it is removed: closing the bar with the X left
     * `mInputShown=true` on a served view that takes no input (the bare
     * `AndroidComposeView`), so the next Back went to the IME instead of this
     * screen's `BackHandler` and leaving the note took a second press. Clearing
     * focus as the bar goes away is what drops that keyboard — a bridge
     * `blur()` cannot, because the WebView is unfocused while find owns the
     * field. This is a structural lock; the behavioral oracle is
     * `dumpsys input_method` on a device.
     */
    @Test
    fun `dismissing find drops the keyboard its query field owns`() {
        val dismiss = noteEditorSource()
            .substringAfter("fun dismissFind()")
            .substringBefore("fun openNoteEffects")

        assertTrue(dismiss.contains("focusManager.clearFocus(force = true)"))
        assertTrue(dismiss.contains("!host.editorFocused"))
        assertTrue(
            dismiss.indexOf("clearFocus") in 0 until dismiss.indexOf("savedFindVisible = false"),
        )
    }

    @Test
    fun `ime visibility stays scoped to the toolbar composition group`() {
        val source = noteEditorSource()

        assertFalse(source.contains("val findImeVisible = WindowInsets.isImeVisible"))
        assertTrue(source.contains("if (host.editorFocused && WindowInsets.isImeVisible)"))
    }
}
