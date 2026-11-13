#if DEBUG
    import Combine
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// Once a leave is pending, the leave registry owns ALL saving for the draft: the controller's
    /// own timer is gone, failures are told once and never through the closed screen, retries back
    /// off, backgrounding attempts every pending leave under background time, and Discard and a
    /// full reset fence every save that has not started. Production pacing (2 s first retry)
    /// unless a test says otherwise: a shortened retry hid the controller's own timer.
    @Suite(.serialized) @MainActor
    struct TextFirstLeaveOwnershipTests {
        @discardableResult
        private func leave(_ rig: TextFirstVaultRig) -> UInt64 {
            let token = rig.store.claimDraftOwnership()
            TextFirstLeaves.leave(
                controller: rig.controller, store: rig.store, ownerToken: token,
                discardIfEmpty: false, originalId: rig.controller.noteId)
            return token
        }

        /// Type, make every write fail, leave.
        private func failingLeave(_ rig: TextFirstVaultRig) {
            rig.selectEnd()
            rig.type(" typed")
            rig.blockWrites()
            leave(rig)
        }

        /// The leave has tried once and failed (the draft model says so).
        private func firstFailure(_ rig: TextFirstVaultRig) async -> Bool {
            await rig.until(3) { rig.controller.saveModel.failed }
        }

        /// While a leave is pending, the one retry loop tells the user once; the left screen's
        /// own failure callback is never called again (in the app it raises the toast, and every
        /// call restarted the toast's 3.5 s, so it never went away).
        @Test func aPendingLeaveReportsItsFailureOnceAndNeverThroughTheLeftScreen() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            var toasts = 0
            let watch = rig.store.$transientMessage.sink { if $0 != nil { toasts += 1 } }
            defer { watch.cancel() }
            failingLeave(rig)
            try await Task.sleep(nanoseconds: 7_000_000_000)
            #expect(rig.failures.count == 0)
            #expect(toasts == 1)
            // Still pending, still the same draft: the user opens the note again and gets it.
            let taken = try #require(await TextFirstLeaves.claim("note"))
            rig.allowWrites()
            #expect(await rig.checkpoint())
            _ = await taken.close()
        }

        /// The leave's loop is the only thing that saves: a failed detach does not re-arm the
        /// controller's timer, and neither does the late result of a save the screen had queued.
        @Test func theControllersOwnTimerStaysOffWhileALeaveIsPending() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(rig.controller.saveTimer == nil)
            #expect(await firstFailure(rig))
            #expect(rig.controller.saveTimer == nil)
            rig.controller.saved(
                .failure(TextFirstNeverOpened()), identity: nil, epoch: rig.controller.identityEpoch
            )
            #expect(rig.controller.saveTimer == nil)
            #expect(!(await rig.checkpoint()))
            let taken = try #require(await TextFirstLeaves.claim("note"))
            // Handed back, the screen owns the draft's saving again.
            #expect(taken.saveTimer != nil)
            rig.allowWrites()
            _ = await taken.close()
        }

        /// 2 s, 4 s, 8 s ... capped at 60 s; the clock is injected so the schedule is read, not waited.
        @Test func retriesBackOffFromTwoSecondsToTheCap() async throws {
            var naps: [UInt64] = []
            TextFirstLeaves.pacing.sleep = { delay in
                naps.append(delay)
                try? await Task.sleep(nanoseconds: 2_000_000)
            }
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(await rig.until(10) { naps.count >= 8 })
            let seconds: [UInt64] = [2, 4, 8, 16, 32, 60, 60, 60]
            #expect(Array(naps.prefix(8)) == seconds.map { $0 * 1_000_000_000 })
            let taken = try #require(await TextFirstLeaves.claim("note"))
            rig.allowWrites()
            _ = await taken.close()
        }

        /// Backgrounding does not wait out the backoff: every pending leave attempts at once,
        /// under a background task that ends with the attempt.
        @Test func backgroundingAttemptsEveryPendingLeaveNowUnderBackgroundTime() async throws {
            var began: [String] = []
            var ended: [Int] = []
            TextFirstLeaves.pacing.base = 60_000_000_000
            TextFirstLeaves.pacing.background = BackgroundTaskProvider(
                begin: { name, _ in
                    began.append(name)
                    return began.count
                },
                end: { ended.append($0) })
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(await firstFailure(rig))
            // Asleep for a minute; the disk recovers; the app leaves the foreground.
            rig.allowWrites()
            NotificationCenter.default.post(
                name: UIApplication.willResignActiveNotification, object: nil)
            #expect(await rig.until(3) { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note")?.contains("typed") == true)
            #expect(began.count == 1)
            #expect(ended == [1])
        }

        /// A background attempt that fails still gives its time back, and the leave goes on.
        @Test func aFailedBackgroundAttemptEndsItsBackgroundTaskAndTheLeaveContinues() async throws
        {
            var began = 0
            var ended = 0
            TextFirstLeaves.pacing.base = 60_000_000_000
            TextFirstLeaves.pacing.background = BackgroundTaskProvider(
                begin: { _, _ in
                    began += 1
                    return began
                },
                end: { _ in ended += 1 })
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(await firstFailure(rig))
            TextFirstLeaves.flushForBackground()
            #expect(await rig.until(3) { ended == 1 })
            #expect(began == 1)
            #expect(TextFirstLeaves.unsettled == 1)
            let taken = try #require(await TextFirstLeaves.claim("note"))
            rig.allowWrites()
            #expect(await rig.checkpoint())
            _ = await taken.close()
        }

        /// The note was opened again and popped again before the claim finished: the screen
        /// declines the draft, and its leave keeps owning (and saving) it.
        @Test func aHandoverTheScreenDeclinesLeavesTheDraftWithItsLeave() async throws {
            TextFirstLeaves.pacing = TextFirstLeaves.Pacing(
                base: 10_000_000, cap: 10_000_000)
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(await firstFailure(rig))
            let declined = await TextFirstLeaves.claim("note") { _ in false }
            #expect(declined == nil)
            #expect(TextFirstLeaves.unsettled == 1)
            #expect(rig.controller.savingYielded)
            #expect(rig.source.contains("typed"))
            rig.allowWrites()
            #expect(await rig.until(5) { TextFirstLeaves.unsettled == 0 })
            #expect(rig.disk("note")?.contains("typed") == true)
        }

        /// Taking the draft is one step: the registry lets go and the screen's saving resumes
        /// together, so the draft never has two owners or none.
        @Test func aHandoverTheScreenTakesMakesTheScreenTheOnlyOwner() async throws {
            TextFirstLeaves.pacing = TextFirstLeaves.Pacing(
                base: 10_000_000, cap: 10_000_000)
            defer { TextFirstLeaves.pacing = TextFirstLeaves.Pacing() }
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(await firstFailure(rig))
            var mounted: TextFirstEditorController?
            let taken = await TextFirstLeaves.claim("note") { made in
                // Still the registry's while the screen mounts it.
                #expect(TextFirstLeaves.unsettled == 1)
                #expect(made.savingYielded)
                mounted = made
                return true
            }
            #expect(taken === rig.controller)
            #expect(taken === mounted)
            #expect(TextFirstLeaves.unsettled == 0)
            #expect(!rig.controller.savingYielded)
            #expect(rig.controller.saveTimer != nil)
            rig.allowWrites()
            #expect(await rig.checkpoint())
            _ = await rig.controller.close()
        }

        /// R3: a save already queued on the I/O queue (the banner's Retry, the timer) must not
        /// write edits the user then confirmed discarding. The queue is held so the save is
        /// queued, not yet started: a save already inside the engine's write is ordered before
        /// the Discard, like an autosave a moment earlier.
        @Test func aDiscardedDraftIsNotWrittenByASaveQueuedBeforeTheDiscard() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            rig.selectEnd()
            rig.type(" typed")
            let held = DispatchSemaphore(value: 0)
            rig.controller.io.async { held.wait() }
            rig.controller.checkpoint()  // Retry tapped
            rig.controller.discard()  // ...Discard confirmed before the retry starts
            held.signal()
            try await Task.sleep(nanoseconds: 1_000_000_000)
            #expect(rig.disk("note") == "keep me")
            #expect(rig.checkpoints.isEmpty)
            #expect(rig.failures.isEmpty)
        }

        /// A full reset ends every pending leave at once, in the same turn, and what each held
        /// is never written.
        @Test func aFullResetEndsEveryPendingLeaveAtOnce() async throws {
            let rig = try await TextFirstVaultRig(body: "keep me")
            defer { rig.tearDown() }
            failingLeave(rig)
            #expect(TextFirstLeaves.unsettled == 1)
            rig.store.beginFullReset()
            #expect(TextFirstLeaves.unsettled == 0)
            #expect(rig.controller.closed)
            rig.allowWrites()
            #expect(!(await rig.checkpoint()))
            #expect(rig.disk("note") == "keep me")
        }
    }
#endif
