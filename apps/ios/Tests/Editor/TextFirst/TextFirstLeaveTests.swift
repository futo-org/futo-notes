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
        /// Constant fast retries, for the tests that are not about pacing (the pacing and the
        /// controller's own timer are in TextFirstLeaveOwnershipTests, at production speed).
        private func hurry(_ nanoseconds: UInt64 = 10_000_000) {
            TextFirstLeaves.pacing.base = nanoseconds
            TextFirstLeaves.pacing.cap = nanoseconds
        }

        /// Type, make every write fail, leave, and let far more than the old limit of ten detach
        /// attempts fail.
        private func failingLeave(_ rig: TextFirstVaultRig) async throws {
            hurry()
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
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            // Many more than ten attempts have failed: the draft is still owned, not dropped.
            #expect(TextFirstLeaves.unsettled == 1)
            #expect(rig.source.contains("typed"))
            await #expect(throws: EditorSessionError.self) {
                _ = try await rig.store.openEditorSession(await rig.store.readForEditor("note"))
            }
            // The disk recovers: the retry that was never given up on writes the draft.
            rig.allowWrites()
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note")?.contains("typed") == true)
            let again = try await rig.store.openEditorSession(
                await rig.store.readForEditor("note"))
            _ = try again.detach()
        }

        @Test func openingTheNoteAgainTakesBackTheSameDraftWithItsSaveError() async throws {
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
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
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
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
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            try await failingLeave(rig)
            // Slow the retries so the disk can be opened for the peer's rename without the leave
            // slipping its save in.
            hurry(3_000_000_000)
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
        /// Production pacing: with the retry shortened the controller's own timer (2 s, armed by a
        /// failed detach) never got its turn, and a wiped note came back.
        @Test func aStoreResetEndsARetainedLeaveWithoutWritingTheDraft() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            rig.selectEnd()
            rig.type(" typed")
            rig.blockWrites()
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: rig.controller.noteId)
            try await Task.sleep(nanoseconds: 400_000_000)
            #expect(TextFirstLeaves.unsettled == 1)
            rig.store.beginFullReset()
            #expect(TextFirstLeaves.unsettled == 0)
            rig.allowWrites()
            // The wipe itself (what `vault.reset` does to the files).
            try? FileManager.default.removeItem(at: rig.root.appendingPathComponent("note.md"))
            #expect(rig.disk("note") == nil)
            // Past the controller's 2 s retry and the leave's first backoff.
            try await Task.sleep(nanoseconds: 5_000_000_000)
            #expect(rig.disk("note") == nil)
            let files = (try? FileManager.default.contentsOfDirectory(atPath: rig.root.path)) ?? []
            #expect(!files.contains("note.md"))
        }

        /// A title typed just before Back (inside the screen's rename debounce) is not lost: the
        /// leave renames to it, then saves under the new name.
        @Test func aTitleTypedJustBeforeLeavingIsCommittedByTheLeave() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            rig.selectEnd()
            rig.type(" typed")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: rig.controller.noteId, pendingTitle: "Renamed")
            let deadline = Date().addingTimeInterval(10)
            while TextFirstLeaves.unsettled > 0, Date() < deadline {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            #expect(TextFirstLeaves.unsettled == 0)
            let files = (try? FileManager.default.contentsOfDirectory(atPath: rig.root.path)) ?? []
            #expect(files.contains("Renamed.md") && !files.contains("note.md"), "\(files)")
            let body = try String(
                contentsOf: rig.root.appendingPathComponent("Renamed.md"), encoding: .utf8)
            #expect(
                body.contains("keep me") && body.contains("typed"), "\(body.debugDescription)")
        }

        /// A new note left untouched is deleted; one a peer renamed meanwhile is somebody's note,
        /// and so is the different note a peer then made at the name it vacated (a leave that
        /// named the screen's old id would delete that one).
        @Test func anUntouchedNewNoteThatAPeerRenamedIsNotDeleted() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            try rig.peerRename("note", to: "peer")
            try rig.peerWrite("note", "somebody else's note\n")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("peer") != nil)
            #expect(rig.disk("note") == "somebody else's note\n")
        }

        /// A peer's write lands on the untouched new note while the screen is open: the leave's
        /// save adopts it, so the note is somebody's now and must survive the leave.
        @Test func anUntouchedNewNoteThatAPeerWroteIsNotDeleted() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            try rig.peerWrite("note", "the peer's words\n")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note") == "the peer's words\n")
        }

        /// Keeping the note must not disturb the rest of the list: a skipped delete's mutation
        /// still carries the vault's folders.
        @Test func keepingAPeerWrittenNoteLeavesTheFolderListAlone() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            _ = await rig.store.createNote(title: "plan", folder: "Projects")
            try rig.peerWrite("note", "the peer's words\n")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note") == "the peer's words\n")
            #expect(rig.store.folders == ["Projects"])
        }

        /// A skipped empty-only delete leaves the note available for later draft writes.
        @Test func aKeptNoteStillAcceptsDraftWrites() async throws {
            let rig = try await TextFirstVaultRig(body: "")
            defer { rig.tearDown() }
            try rig.peerWrite("note", "the peer's words\n")
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: true,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            _ = await rig.store.flushDraft(
                PendingDraft(id: "note", base: "the peer's words\n", content: "mine too\n"))
            #expect(rig.disk("note") == "mine too\n")
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
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(
                body: TextFirstOpeningTests.note(), opening: true)
            defer { rig.tearDown() }
            #expect(rig.controller.opening)
            rig.select(3)
            rig.type("QQ")
            hurry()
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
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(
                body: TextFirstOpeningTests.note(), opening: true, failingOpen: true)
            defer { rig.tearDown() }
            hurry()
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store,
                ownerToken: rig.store.claimDraftOwnership(), discardIfEmpty: false,
                originalId: "note")
            #expect(await rig.until { TextFirstLeaves.unsettled == 0 })
            #expect(rig.controller.closed)
        }
    }
#endif
