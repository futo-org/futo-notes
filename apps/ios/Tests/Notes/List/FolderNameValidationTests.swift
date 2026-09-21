import Foundation
import Testing

@testable import FutoNotesNative

/// The New Folder / Rename Folder dialogs gated only on "empty after sanitize",
/// "case-insensitive duplicate", and "sanitizes away entirely", so a name that
/// contained a forbidden character but still sanitized to something non-empty
/// passed all three: `QA Folder/Bad` left Create enabled and silently created
/// `QA FolderBad` (v1.7.2 verify-specs pass). Desktop has always named the
/// character (`folders.validation.forbiddenCharacter`).
@Suite("Folder name validation")
struct FolderNameValidationTests {
    @Test("a forbidden character blocks the name instead of being dropped on commit")
    func forbiddenCharacterIsReported() {
        #expect(folderNameProblem("QA Folder/Bad") == .forbiddenCharacter)
        #expect(
            folderNameProblem("QA Folder/Bad")?.messagePath
                == "folders.validation.forbiddenCharacter"
        )
    }

    @Test("every character the shared rules forbid is reported")
    func everyForbiddenCharacterIsReported() {
        for character in "<>:\"/\\|?*" {
            #expect(
                folderNameProblem("Specs\(character)Draft") == .forbiddenCharacter,
                "\(character) must be reported, not silently stripped"
            )
        }
        // Control characters are forbidden by the same shared rule.
        #expect(folderNameProblem("Specs\u{0007}Draft") == .forbiddenCharacter)
    }

    @Test("an empty field blocks the action but stays quiet")
    func emptyStaysQuiet() {
        #expect(folderNameProblem("") == .empty)
        #expect(folderNameProblem("   ") == .empty)
        #expect(folderNameProblem("")?.messagePath == nil)
    }

    @Test("a name that only survives via the Untitled fallback is invalid")
    func sanitizesAwayIsInvalid() {
        // "///" is forbidden characters first; "..." reaches the fallback
        // through dot stripping alone, which is the case this guards.
        #expect(folderNameProblem("...") == .sanitizesAway)
        #expect(folderNameProblem("...")?.messagePath == "folders.invalidName")
    }

    @Test("literally typing the fallback name is allowed")
    func literalFallbackIsAllowed() {
        #expect(folderNameProblem("Untitled") == nil)
    }

    @Test("an ordinary folder name is usable")
    func ordinaryNameIsUsable() {
        #expect(folderNameProblem("QA Folder") == nil)
        #expect(folderNameProblem("  Specs  ") == nil)
    }
}
