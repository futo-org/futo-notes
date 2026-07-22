// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).
// Regenerate: `just title-spec`. `just title-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

package com.futo.notes.ui

/**
 * Characters stripped by the Android live title filter: `< > : " / \ | ? *`,
 * C0 control characters, and DEL, matching the shared TS fast path. The
 * canonical Rust FFI validator supplies authoritative validation + messages.
 */
object TitleSpec {
    val forbiddenChars = Regex("[<>:\"/\\\\|?*\\x00-\\x1F\\x7F]")

    /** Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`. */
    const val maxLength = 200
}
