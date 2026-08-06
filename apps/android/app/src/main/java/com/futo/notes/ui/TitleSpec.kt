// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).
// Regenerate: `just title-spec`. `just title-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

package com.futo.notes.ui

/**
 * Characters stripped by the Android live title filter: `< > : " / \ | ? *`,
 * C0 control characters, DEL, and C1 controls, matching the shared rule. The
 * canonical Rust FFI validator supplies authoritative validation + messages.
 */
object TitleSpec {
    val forbiddenChars = Regex("[<>:\"/\\\\|?*\\x00-\\x1F\\x7F-\\x9F]")

    /** Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`. */
    const val maxLength = 200
}
