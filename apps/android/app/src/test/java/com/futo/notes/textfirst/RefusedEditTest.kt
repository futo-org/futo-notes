package com.futo.notes.textfirst

import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.EditorBlockCommand
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorSessionException

class RefusedEditTest {
    @Test fun listIndentAndOutdentSayIndentOtherBlockCommandsSayFormatting() {
        assertEquals(RefusedEdit.INDENT, RefusedEdit.forBlock(EditorBlockCommand.Indent))
        assertEquals(RefusedEdit.INDENT, RefusedEdit.forBlock(EditorBlockCommand.Outdent))
        assertEquals(RefusedEdit.FORMAT, RefusedEdit.forBlock(EditorBlockCommand.BulletList))
        assertEquals(RefusedEdit.FORMAT, RefusedEdit.forBlock(EditorBlockCommand.Heading(2u)))
        assertEquals(RefusedEdit.INDENT, RefusedEdit.forKey(EditorParagraphKey.TAB))
        assertEquals(RefusedEdit.INDENT, RefusedEdit.forKey(EditorParagraphKey.SHIFT_TAB))
        assertEquals(RefusedEdit.EDIT, RefusedEdit.forKey(EditorParagraphKey.ENTER))
    }

    @Test fun aRefusalToastsItsActionAndAnInternalDesyncToastsTheFallback() {
        val refused = EditorSessionException.UnrepresentableFormat()
        assertEquals(RefusedEdit.INDENT, RefusedEdit.toastFor(RefusedEdit.INDENT, refused))
        assertEquals(RefusedEdit.TEXT, RefusedEdit.toastFor(RefusedEdit.TEXT, EditorSessionException.CompositionActive()))
        assertEquals(RefusedEdit.EDIT, RefusedEdit.toastFor(RefusedEdit.FORMAT, EditorSessionException.InvalidRange()))
        assertEquals(RefusedEdit.EDIT, RefusedEdit.toastFor(RefusedEdit.TEXT, EditorSessionException.InvalidText()))
    }

    @Test fun hostWorkTheUserDidNotAskForNeverToasts() {
        assertNull(RefusedEdit.toastFor(null, EditorSessionException.UnrepresentableFormat()))
        assertNull(RefusedEdit.toastFor(null, EditorSessionException.InvalidRange()))
    }

    @Test fun everyKindHasItsOwnEditorRefusedMessage() {
        val keys = RefusedEdit.entries.map { it.messageKey }
        assertEquals(keys.size, keys.toSet().size)
        assertTrue(keys.all { it.startsWith("editor.refused.") })
    }

    @Test fun aBurstOfRefusalsShowsOneToastEveryTwoSeconds() {
        val throttle = RefusalToastThrottle()
        assertTrue(throttle.admit(10_000))
        assertFalse(throttle.admit(10_050))
        assertFalse(throttle.admit(11_999))
        assertTrue(throttle.admit(12_000))
        assertFalse(throttle.admit(12_100))
    }
}
