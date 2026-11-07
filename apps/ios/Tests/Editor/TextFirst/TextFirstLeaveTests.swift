#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A leave that cannot save keeps the draft (docs/spec/editor/portable-core/recovery.md: closing
    /// saves first and, if the save fails, the session stays attached; dropping it loses the edits).
    /// The failure is the filesystem's: the vault directory has no write bit.
    @Suite(.serialized) @MainActor
    struct TextFirstLeaveTests {
        /// Type, make every write fail, leave, and let far more than the old limit of ten detach
        /// attempts fail.
        private func failingLeave(_ rig: TextFirstVaultRig) async throws {
            TextFirstLeaves.retryNanoseconds = 10_000_000
            rig.selectEnd()
            rig.type(" typed")
            rig.blockWrites()
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: rig.controller.noteId)
            try await Task.sleep(nanoseconds: 1_500_000_000)
        }

        @Test func aLeaveThatCannotSaveKeepsTheAttachmentAndSavesWhenTheDiskRecovers() async throws
        {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            // Many more than ten attempts have failed: the draft is still owned, not dropped.
            #expect(TextFirstLeaves.unsettled == 1)
            #expect(rig.source.contains("typed"))
            await #expect(throws: EditorSessionError.self) {
                _ = try await rig.store.openEditorSession("note")
            }
            // The disk recovers: the retry that was never given up on writes the draft.
            rig.allowWrites()
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note")?.contains("typed") == true)
            let again = try await rig.store.openEditorSession("note")
            _ = try again.detach()
        }

        @Test func openingTheNoteAgainTakesBackTheSameDraftWithItsSaveError() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            let taken = await TextFirstLeaves.claim("note")
            #expect(taken === rig.controller)
            #expect(taken?.saveModel.failed == true)
            #expect(rig.source.contains("typed"))
            // The old screen's draft ownership ended with the hand-over, not before.
            #expect(TextFirstLeaves.unsettled == 0)
            // Retry from the screen: durable once the disk allows it.
            rig.allowWrites()
            #expect(await rig.checkpoint())
            #expect(rig.disk("note")?.contains("typed") == true)
            #expect(taken?.saveModel.failed == false)
            _ = await rig.controller.close()
        }

        @Test func discardingReleasesTheAttachmentWithoutWritingTheDraft() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            let taken = try #require(await TextFirstLeaves.claim("note"))
            rig.allowWrites()
            let onDisk = rig.disk("note")
            taken.discard()
            #expect(taken.closed)
            // Nothing saves a discarded draft, not even a checkpoint.
            #expect(await rig.checkpoint() == false)
            #expect(rig.disk("note") == onDisk)
            #expect(rig.disk("note")?.contains("typed") == false)
        }

        /// A peer renames the note while its leave keeps failing: the retained draft is claimed
        /// under the attachment's id, not under the name the screen was opened with.
        @Test func aRetainedLeaveIsClaimedByTheAttachmentsOwnId() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            // Slow the retries so the disk can be opened for the peer's rename without the leave
            // slipping its save in.
            TextFirstLeaves.retryNanoseconds = 3_000_000_000
            try await Task.sleep(nanoseconds: 100_000_000)
            rig.allowWrites()
            try rig.peerRename("note", to: "peer")
            rig.blockWrites()
            #expect(await TextFirstLeaves.claim("note") == nil)
            let taken = try #require(await TextFirstLeaves.claim("peer"))
            #expect(taken === rig.controller)
            #expect(taken.noteId == "peer")
            rig.allowWrites()
            #expect(await rig.checkpoint())
            #expect(rig.disk("peer")?.contains("typed") == true)
            #expect(rig.disk("note") == nil)
            _ = await taken.close()
        }

        /// A full reset retires every draft: a retained leave must not write one back afterwards.
        @Test func aStoreResetEndsARetainedLeaveWithoutWritingTheDraft() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            rig.store.beginFullReset()
            rig.allowWrites()
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note")?.contains("typed") == false)
        }

        /// A new note left untouched is deleted; one a peer renamed meanwhile is somebody's note.
        @Test func anUntouchedNewNoteThatAPeerRenamedIsNotDeleted() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            try rig.peerRename("note", to: "peer")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("peer") != nil)
        }

        @Test func anUntouchedNewNoteIsDeleted() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note") == nil)
        }

        /// A long note left while the engine's open is still landing: what was typed is applied,
        /// and when the save then fails the draft is kept like any other.
        @Test func aLeaveDuringTheOpeningKeepsWhatWasTypedWhenTheSaveFails() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(
                body: TextFirstOpeningTests.note(), opening: true)
            defer { rig.tearDown() }
            #expect(rig.controller.opening)
            rig.select(3)
            rig.type("QQ")
            TextFirstLeaves.retryNanoseconds = 10_000_000
            rig.blockWrites()
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: "note")
            try await Task.sleep(nanoseconds: 1_500_000_000)
            #expect(TextFirstLeaves.unsettled == 1)
            let taken = try #require(await TextFirstLeaves.claim("note"))
            #expect(!taken.opening)
            #expect(rig.source.contains("QQ"))
            #expect(taken.saveModel.failed)
            rig.allowWrites()
            #expect(await rig.checkpoint())
            #expect(rig.disk("note")?.contains("QQ") == true)
            _ = await taken.close()
        }

        /// An open that never lands has nothing to keep: the leave ends instead of retrying.
        @Test func aLeaveOfAnEditorThatNeverOpenedEnds() async throws {
            defer { TextFirstLeaves.retryNanoseconds = 2_000_000_000 }
            let rig = try await TextFirstVaultRig(
                body: TextFirstOpeningTests.note(), opening: true, failingOpen: true)
            defer { rig.tearDown() }
            TextFirstLeaves.retryNanoseconds = 10_000_000
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.controller.closed)
        }
    }
#endif
