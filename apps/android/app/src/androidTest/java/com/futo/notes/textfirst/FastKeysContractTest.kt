package com.futo.notes.textfirst

import androidx.test.platform.app.InstrumentationRegistry
import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.NativeEditorSession
import uniffi.futo_notes_ffi.NoteStore

class FastKeysContractTest {
    @Test
    fun jniMatchesCanonicalBindingsIncludingUnicodeFailuresAndHandleLifetime() {
        val root = Files.createTempDirectory(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir.toPath(), "fast-keys-")
        val store = NoteStore(root.toString())
        store.createNote("jna", "", "hello 😀\n- item")
        store.createNote("jni", "", "hello 😀\n- item")
        val canonical = store.openEditor("jna")
        val accelerated = store.openEditor("jni")
        val fast = FastSession.of(accelerated)
        fun units(text: String) = text.map { it.code.toUShort() }
        try {
            for (typed in listOf("a", "é", "😀", "العربية", "\n", "e\u0301")) {
                val at = canonical.displayText().length
                val expected = canonical.replaceUtf16Action(canonical.revision(), EditorUtf16Range(at.toULong(), at.toULong()), units(typed), EditorInputAction.TYPING)
                val actual = fast.replace(accelerated.revision(), at, at, typed, EditorInputAction.TYPING)
                assertEquals(expected, actual)
                assertEquals(canonical.sourceText(), accelerated.sourceText())
            }
            for (key in listOf(EditorParagraphKey.ENTER, EditorParagraphKey.BACKSPACE, EditorParagraphKey.SHIFT_ENTER, EditorParagraphKey.BACKSPACE_JOINING_HEADING)) {
                val at = canonical.displayText().length
                assertEquals(
                    canonical.paragraphKeyUtf16(canonical.revision(), EditorUtf16Range(at.toULong(), at.toULong()), key),
                    fast.paragraphKey(accelerated.revision(), at, at, key),
                )
                assertEquals(canonical.sourceText(), accelerated.sourceText())
            }
            fun failure(call: () -> Unit): Class<out Throwable>? = try { call(); null } catch (error: Exception) { error.javaClass }
            // Transport must not normalize a lone UTF-16 surrogate into U+FFFD.
            assertEquals(
                failure { canonical.replaceUtf16Action(canonical.revision(), EditorUtf16Range(0u, 0u), units("\uD800"), EditorInputAction.TYPING) },
                failure { fast.replace(accelerated.revision(), 0, 0, "\uD800", EditorInputAction.TYPING) },
            )
            assertEquals(
                failure { canonical.replaceUtf16Action(0u, EditorUtf16Range(0u, 0u), units("x"), EditorInputAction.TYPING) },
                failure { fast.replace(0u, 0, 0, "x", EditorInputAction.TYPING) },
            )
            assertEquals(canonical.sourceText(), accelerated.sourceText())
            fast.close()
            fast.close() // exactly one Arc clone is released
            assertThrows(IllegalStateException::class.java) { fast.paragraphKey(accelerated.revision(), 0, 0, EditorParagraphKey.ENTER) }
        } finally {
            fast.close()
            for (session: NativeEditorSession in listOf(canonical, accelerated)) { session.detach(); session.destroy() }
            store.destroy()
            root.toFile().deleteRecursively()
        }
    }

    @Test
    fun malformedNativePayloadCannotBecomeASilentNoOp() {
        assertThrows(IllegalStateException::class.java) { FastKeys.decode(byteArrayOf()) }
        assertThrows(IllegalStateException::class.java) { FastKeys.decode(byteArrayOf(3)) }
        assertThrows(IllegalStateException::class.java) { FastKeys.decode(byteArrayOf(2, 0)) }
    }
}
