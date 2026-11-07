#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The editor follows the note it is attached to when the engine moves the attachment: a peer's
    /// rename, and the conflict copy a save parks a draft in. The id comes from the attachment
    /// itself, never from a file name pattern.
    @Suite(.serialized) @MainActor
    struct TextFirstIdentityTests {
        @Test func aPeerRenameMovesTheEditorToTheRenamedNote() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta")
            defer { rig.tearDown() }
            var told: [String] = []
            rig.controller.onIdentityChange = { told.append($0) }
            rig.select(5)
            rig.type(" one")
            try rig.peerRename("note", to: "peer")
            #expect(try rig.controller.session.noteId() == "peer")
            #expect(await rig.checkpoint())
            #expect(rig.controller.noteId == "peer")
            #expect(told == ["peer"])
            #expect(rig.disk("peer")?.contains("one") == true)
            #expect(rig.disk("note") == nil)
            _ = await rig.controller.close()
        }

        @Test func aPeerRenameThenAFailedSaveStillMovesTheEditorAndRetriesAtTheNewId()
            async throws
        {
            let rig = try await TextFirstVaultRig(body: "alpha beta")
            defer { rig.tearDown() }
            rig.select(5)
            rig.type(" one")
            try rig.peerRename("note", to: "peer")
            rig.blockWrites()
            #expect(!(await rig.checkpoint()))
            #expect(!rig.failures.isEmpty)
            #expect(rig.controller.noteId == "peer")
            rig.allowWrites()
            #expect(await rig.checkpoint())
            #expect(rig.disk("peer")?.contains("one") == true)
            // The retry never recreated the vacated name.
            #expect(rig.disk("note") == nil)
            _ = await rig.controller.close()
        }

        @Test func parkingADraftMovesTheEditorToTheConflictCopy() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            rig.select(16)
            rig.type("!!")
            // The same word changed both ways: no clean merge, the draft is parked.
            try rig.peerWrite("note", "alpha beta delta\n")
            #expect(await rig.checkpoint())
            guard case .parkedConflict(let parked) = rig.checkpoints.last?.disposition else {
                Issue.record(
                    "expected a parked conflict, got \(String(describing: rig.checkpoints.last?.disposition))"
                )
                return
            }
            #expect(try rig.controller.session.noteId() == parked)
            #expect(rig.controller.noteId == parked)
            #expect(rig.disk("note") == "alpha beta delta\n")
            #expect(rig.disk(parked)?.contains("gamma!!") == true)
            _ = await rig.controller.close()
        }

        /// The title field acts on the note the editor is attached to now: after a peer's rename a
        /// typed title renames that note (not the vacated name, where a peer's note may now sit).
        @Test func aTitleTypedAfterAPeerRenameRenamesTheAttachedNote() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta")
            defer { rig.tearDown() }
            rig.select(5)
            rig.type(" one")
            try rig.peerRename("note", to: "peer")
            // A different note took over the vacated name.
            try rig.peerWrite("note", "somebody else's note\n")
            let token = rig.store.claimDraftOwnership()
            let outcome = await TextFirstTitle.rename(
                to: "typed", controller: rig.controller, store: rig.store, ownerToken: token)
            #expect(outcome == .renamed("typed"))
            #expect(rig.controller.noteId == "typed")
            #expect(try rig.controller.session.noteId() == "typed")
            #expect(rig.disk("typed") != nil)
            #expect(rig.disk("peer") == nil)
            #expect(rig.disk("note") == "somebody else's note\n")
            // The draft the rename kept saves at the new name.
            #expect(await rig.checkpoint())
            #expect(rig.disk("typed")?.contains("one") == true)
            _ = await rig.controller.close()
        }

        @Test func theTitleFieldFollowsAnUneditedTitleAndKeepsATypedOne() {
            #expect(TextFirstTitle.fieldText("note", from: "note", to: "peer") == "peer")
            #expect(TextFirstTitle.fieldText("typing", from: "note", to: "peer") == "typing")
            #expect(TextFirstTitle.fieldText("note", from: "a/note", to: "a/peer") == "peer")
        }

        /// An image picked before the identity changed lands in the same attached note: the claim
        /// belongs to the attachment, and the file goes to the vault root whatever the note is called.
        @Test func aDelayedImageResultLandsAfterARename() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            rig.select(5)
            let claim = try #require(rig.controller.beginImageInsertion())
            rig.type(" one")
            try rig.peerRename("note", to: "peer")
            #expect(await rig.checkpoint())
            #expect(rig.controller.insertSavedImage(filename: "pic.png", claim: claim))
            #expect(rig.source.contains("![](pic.png)"))
            _ = await rig.controller.close()
        }

        @Test func aDelayedImageResultLandsAfterAPark() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            rig.select(16)
            let claim = try #require(rig.controller.beginImageInsertion())
            rig.type("!!")
            try rig.peerWrite("note", "alpha beta delta\n")
            #expect(await rig.checkpoint())
            guard case .parkedConflict = rig.checkpoints.last?.disposition else {
                Issue.record("expected a parked conflict")
                return
            }
            #expect(rig.controller.insertSavedImage(filename: "pic.png", claim: claim))
            #expect(rig.source.contains("![](pic.png)"))
            _ = await rig.controller.close()
        }
    }
#endif
