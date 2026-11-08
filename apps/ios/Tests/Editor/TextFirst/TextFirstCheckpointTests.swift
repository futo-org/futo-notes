#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// A checkpoint that settles marked text before an outside write is adopted
    /// (docs/spec/editor/portable-core/recovery.md): the engine's own change reaches the view
    /// whether the save then succeeds or fails, even while the view still holds marked text.
    ///
    /// The timer's save (`saveIfDue`) does not end a composition first, unlike a checkpoint the
    /// controller asks for, so it is the path that reaches the engine with marked text pending.
    @Suite(.serialized) @MainActor
    struct TextFirstCheckpointTests {
        /// "alpha one|X beta gamma" with X still marked, and a peer's change to a different word
        /// ("gamma" to "GAMMA") on disk: a clean merge once the composition is settled.
        private func composingOverAnOutsideEdit(_ rig: TextFirstVaultRig) throws {
            rig.select(5)
            rig.type(" one")
            rig.tv.setMarkedText("X", selectedRange: NSRange(location: 1, length: 0))
            #expect(rig.controller.engineComposing)
            try rig.peerWrite("note", "alpha beta GAMMA\n")
        }

        private func expectViewFollowsEngine(_ rig: TextFirstVaultRig) {
            #expect(rig.controller.rev == rig.engineRevision)
            #expect(!rig.controller.engineComposing)
            #expect(rig.tv.markedTextRange == nil)
            #expect(rig.display == rig.engineDisplay)
            #expect(rig.controller.divergences.isEmpty)
        }

        @Test func aFailedSaveStillDeliversTheSettledCompositionAndTheNextInputLands()
            async throws
        {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            try composingOverAnOutsideEdit(rig)
            rig.blockWrites()
            #expect(await rig.until { !rig.failures.isEmpty })
            expectViewFollowsEngine(rig)
            #expect(rig.display.contains("oneX"))
            // The next keystroke is accepted at the engine's revision, not refused as stale.
            rig.type("Z")
            #expect(rig.source.contains("oneXZ"))
            expectViewFollowsEngine(rig)
            // Persistence recovers: the merge of both contributions is written.
            rig.allowWrites()
            #expect(await rig.checkpoint())
            #expect(rig.disk("note")?.contains("oneXZ") == true)
            #expect(rig.disk("note")?.contains("GAMMA") == true)
            expectViewFollowsEngine(rig)
            _ = await rig.controller.close()
        }

        @Test func aSavedMergeIsDeliveredWhileTheViewHeldMarkedText() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            try composingOverAnOutsideEdit(rig)
            #expect(await rig.until { !rig.checkpoints.isEmpty })
            expectViewFollowsEngine(rig)
            #expect(rig.display.contains("oneX"))
            #expect(rig.display.contains("GAMMA"))
            rig.type("Z")
            #expect(rig.source.contains("oneXZ"))
            expectViewFollowsEngine(rig)
            _ = await rig.controller.close()
        }

        /// A large engine job (a toolbar command, a find scan) holds the session on its queue: a
        /// save that finishes meanwhile leaves the engine's changes for the job's end, which
        /// delivers them. Nothing calls the engine from the main thread in between.
        @Test func changesWaitForARunningEngineJobAndAreDeliveredWhenItEnds() async throws {
            let rig = try await TextFirstVaultRig(body: "alpha beta gamma")
            defer { rig.tearDown() }
            rig.select(5)
            rig.type(" one")
            try rig.peerWrite("note", "alpha beta GAMMA\n")
            rig.controller.engineJobs = 1
            #expect(await rig.checkpoint())
            #expect(rig.controller.drainDeferred)
            #expect(rig.controller.rev != rig.engineRevision)
            rig.controller.engineJobs = 0
            rig.controller.settleJobs()
            #expect(!rig.controller.drainDeferred)
            expectViewFollowsEngine(rig)
            #expect(rig.display.contains("GAMMA"))
            rig.type("Z")
            #expect(rig.source.contains("oneZ"))
            expectViewFollowsEngine(rig)
            _ = await rig.controller.close()
        }
    }
#endif
