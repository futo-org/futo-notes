// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/filename.ts (@futo-notes/editor).
// Regenerate: `just title-spec`. `just title-spec-check` (part of
// `just check`) fails when this file drifts from the manifest.

import Foundation

/// Characters forbidden in a note title: `< > : " / \ | ? *` plus Unicode
/// control characters, matching the canonical Rust rule. Used only for live
/// input filtering; authoritative validation + messages come from Rust FFI.
///
/// This is deliberately wider than the TS/Android live filter because Unicode
/// `.controlCharacters` also covers the C1 range (0x80–0x9F).
enum TitleSpec {
    static let forbiddenScalars: CharacterSet =
        CharacterSet(charactersIn: "<>:\"/\\|?*").union(.controlCharacters)

    /// Max title length (chars) — matches the shared `MAX_TITLE_LENGTH`.
    static let maxLength = 200
}
