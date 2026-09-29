// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).
// Regenerate: `just title-spec`. `just title-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

import Foundation

/// Characters forbidden in a note title: `< > : " / \ | ? *` plus the C0, DEL,
/// and C1 control ranges, matching the canonical Rust rule. Used only for live
/// input filtering; authoritative validation + messages come from Rust FFI.
enum TitleSpec {
    static let forbiddenScalars: CharacterSet =
        CharacterSet(charactersIn: "<>:\"/\\|?*")
        .union(CharacterSet(charactersIn: "\u{0}"..."\u{1F}"))
        .union(CharacterSet(charactersIn: "\u{7F}"..."\u{9F}"))

    /// Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`.
    static let maxLength = 200
}
