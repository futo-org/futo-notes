package com.futo.notes.textfirst

import java.nio.ByteBuffer
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorViewChange
import uniffi.futo_notes_ffi.FfiConverterTypeEditorSessionError
import uniffi.futo_notes_ffi.FfiConverterTypeEditorViewChange
import uniffi.futo_notes_ffi.NativeEditorSession

/**
 * Per-key engine calls over plain JNI
 * (crates/futo-notes-ffi/src/editor/jni_keys.rs) instead of the JNA-based
 * UniFFI bindings. Results come back in UniFFI's byte encoding and are read
 * with the generated converters.
 */
internal object FastKeys {
    init { System.loadLibrary("futo_notes_ffi") }

    @JvmStatic external fun replace(handle: Long, expected: Long, start: Int, end: Int, inserted: CharArray, action: Int): ByteArray
    @JvmStatic external fun paragraphKey(handle: Long, expected: Long, start: Int, end: Int, key: Int): ByteArray
    @JvmStatic external fun release(handle: Long)

    fun decode(bytes: ByteArray): EditorViewChange? {
        check(bytes.isNotEmpty()) { "Empty native key response" }
        val buf = ByteBuffer.wrap(bytes, 1, bytes.size - 1)
        val result = when (bytes[0].toInt()) {
            0 -> FfiConverterTypeEditorViewChange.read(buf)
            1 -> {
                val error = FfiConverterTypeEditorSessionError.read(buf)
                check(!buf.hasRemaining()) { "Trailing native key error bytes" }
                throw error
            }
            2 -> null
            else -> error("Unknown native key response tag")
        }
        check(!buf.hasRemaining()) { "Trailing native key response bytes" }
        return result
    }
}

/** One open session's handle for [FastKeys]; close it with the session. */
internal class FastSession private constructor(session: NativeEditorSession) : AutoCloseable {
    private var handle = session.uniffiCloneHandle()

    fun replace(rev: ULong, start: Int, end: Int, value: String, action: EditorInputAction): EditorViewChange =
        checkNotNull(FastKeys.decode(FastKeys.replace(liveHandle(), rev.toLong(), start, end, value.toCharArray(), when (action) {
            EditorInputAction.TYPING -> 0
            EditorInputAction.ISOLATED -> 1
            EditorInputAction.COMPOSITION_COMMIT -> 2
        })))

    fun paragraphKey(rev: ULong, start: Int, end: Int, key: EditorParagraphKey): EditorViewChange? =
        FastKeys.decode(FastKeys.paragraphKey(liveHandle(), rev.toLong(), start, end, when (key) {
            EditorParagraphKey.ENTER -> 0
            EditorParagraphKey.SHIFT_ENTER -> 1
            EditorParagraphKey.BACKSPACE -> 2
            EditorParagraphKey.DELETE -> 3
            EditorParagraphKey.TAB -> 4
            EditorParagraphKey.SHIFT_TAB -> 5
            EditorParagraphKey.BACKSPACE_JOINING_HEADING -> 6
        }))

    private fun liveHandle(): Long {
        check(handle != 0L) { "Native key session is closed" }
        return handle
    }

    override fun close() {
        if (handle != 0L) FastKeys.release(handle)
        handle = 0L
    }

    companion object {
        fun of(session: NativeEditorSession): FastSession = FastSession(session)
    }
}
