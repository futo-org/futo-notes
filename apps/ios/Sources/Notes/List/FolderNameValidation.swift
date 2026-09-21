import Foundation

/// The shared rules' fallback title, read back OUT of the rules rather than
/// spelled again here: sanitizing an empty title is what produces it.
private let sanitizeFallbackTitle = sanitizeTitle(title: "")

/// Why a typed folder name cannot be used. A case-insensitive sibling
/// collision is deliberately NOT here: it needs the parent folder's children,
/// which the calling screen owns.
///
/// The authority is the shared Rust rule set reached over FFI (`validateTitle`
/// / `sanitizeTitle`) — never a Swift copy of the forbidden-character list
/// (AGENTS.md M6). Desktop maps the same issue kinds onto the same catalog
/// keys in `src/features/folders/folderOperations.ts`; the shared rules are
/// worded for a note title, so the surface supplies the folder noun.
enum FolderNameProblem: Equatable {
    /// Nothing typed yet. Blocks the action but says nothing (list.md).
    case empty
    /// Contains a character the shared filename rules forbid. Without this the
    /// name passed every gate and was silently sanitized on commit, so
    /// `QA Folder/Bad` created `QA FolderBad` with no message at all
    /// (v1.7.2 verify-specs pass).
    case forbiddenCharacter
    /// Only survives sanitization via the "Untitled" fallback — "..." after
    /// dot stripping, say. Creating then would silently make a folder the user
    /// never named (2026-07-02 QA: "///" created an "Untitled" folder; that
    /// particular input is now reported as `forbiddenCharacter` instead).
    /// Literally typing the fallback name stays allowed.
    case sanitizesAway

    /// Catalog path of the inline message, or nil when the dialog stays quiet.
    var messagePath: String? {
        switch self {
        case .empty:
            return nil
        case .forbiddenCharacter:
            return "folders.validation.forbiddenCharacter"
        case .sanitizesAway:
            return "folders.invalidName"
        }
    }
}

/// The blocking problem with `raw` as a folder name, or nil when it is usable.
///
/// Shared-rule violations are reported BEFORE any sibling collision the caller
/// checks, which is the order desktop uses (`validateFolderNameForDisplay`
/// runs ahead of `hasCaseInsensitiveSiblingCollision`).
func folderNameProblem(_ raw: String) -> FolderNameProblem? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return .empty }
    // `forbidden_chars` is the shared issue kind desktop maps onto the same
    // catalog key; asking Rust keeps the character set in exactly one place.
    if validateTitle(title: trimmed).contains(where: { $0.kind == "forbidden_chars" }) {
        return .forbiddenCharacter
    }
    let clean = sanitizeTitle(title: trimmed)
    if clean.isEmpty { return .empty }
    if clean == sanitizeFallbackTitle && trimmed != sanitizeFallbackTitle {
        return .sanitizesAway
    }
    return nil
}
