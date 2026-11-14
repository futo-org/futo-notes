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

        /// #280: a title rename adopts the store's rewritten self-link as the live
        /// baseline, so the next typed edit cannot save the old target back or park a copy.
        @Test func aTitleRenameKeepsItsSelfLinkThroughFurtherTyping() async throws {
            let rig = try await TextFirstVaultRig(id: "Selfy", body: "back to [[Selfy]]\n")
            defer { rig.tearDown() }
            let token = rig.store.claimDraftOwnership()
            let outcome = await TextFirstTitle.rename(
                to: "SelfyX", controller: rig.controller, store: rig.store, ownerToken: token)
            #expect(outcome == .renamed("SelfyX"))
            #expect(rig.disk("SelfyX") == "back to [[SelfyX]]\n")
            #expect(rig.source == "back to [[SelfyX]]\n")
            rig.selectEnd()
            rig.type("123")
            #expect(await rig.checkpoint())
            #expect(rig.disk("SelfyX") == "back to [[SelfyX]]\n123")
            #expect(rig.disk("Selfy") == nil)
            let files = try FileManager.default.contentsOfDirectory(atPath: rig.root.path)
                .filter { $0.hasPrefix("Selfy") && $0.hasSuffix(".md") }
            #expect(files == ["SelfyX.md"])
            _ = await rig.controller.close()
        }

        /// A save's identity, read on the I/O queue before a title rename retargeted the
        /// attachment, lands on the main thread after the rename adopted its id: it is older than
        /// the rename and must not move the editor back to the vacated name.
        @Test func aStaleSaveIdentityDoesNotUndoARename() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta")
            defer { rig.tearDown() }
            // What a save queued now would carry: the epoch it was queued at.
            let queuedAt = rig.controller.identityEpoch
            let token = rig.store.claimDraftOwnership()
            let outcome = await TextFirstTitle.rename(
                to: "typed", controller: rig.controller, store: rig.store, ownerToken: token)
            #expect(outcome == .renamed("typed"))
            // The save that read `noteId()` == "note" just before the rename, delivered now.
            var told: [String] = []
            rig.controller.onIdentityChange = { told.append($0) }
            rig.controller.saved(.success(nil), identity: "note", epoch: queuedAt)
            #expect(rig.controller.noteId == "typed")
            // The engine is asked again, and says the same.
            _ = await rig.controller.refreshIdentity()
            #expect(rig.controller.noteId == (try rig.controller.session.noteId()))
            #expect(told.isEmpty)
            _ = await rig.controller.close()
        }

        /// The other order is unchanged: a save's identity read after a peer's rename moves the
        /// editor (nothing adopted in between).
        @Test func aSaveIdentityReadAfterAPeerRenameStillMovesTheEditor() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta")
            defer { rig.tearDown() }
            let queuedAt = rig.controller.identityEpoch
            try rig.peerRename("note", to: "peer")
            rig.controller.saved(.success(nil), identity: "peer", epoch: queuedAt)
            #expect(rig.controller.noteId == "peer")
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
