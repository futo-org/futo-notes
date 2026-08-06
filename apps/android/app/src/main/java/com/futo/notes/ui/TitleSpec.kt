// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).
// Regenerate: `just title-spec`. `just title-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

package com.futo.notes.ui

/**
 * Characters stripped by the Android live title filter: `< > : " / \ | ? *`
 * plus the Unicode Cc control characters (C0, DEL, C1), matching the
 * canonical Rust rule. The Rust FFI validator supplies authoritative
 * validation + messages.
 */
object TitleSpec {
    val forbiddenChars = Regex("[<>:\"/\\\\|?*\\u0000-\\u001F\\u007F-\\u009F]")

    /** Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`. */
    const val maxLength = 200
}
