import UIKit
import os

/// Cancellation for the saves queued on a controller's I/O queue: closed once, from the main
/// thread, and read on the queue before each save touches the engine. A save already inside
/// the engine's write is ordered before whatever closed the fence.
final class TextFirstSaveFence: Sendable {
    private let closed = OSAllocatedUnfairLock(initialState: false)
    var isClosed: Bool { closed.withLock { $0 } }
    func close() { closed.withLock { $0 = true } }
}

/// Why a discarded editor's save did not run.
struct TextFirstDiscarded: Error {}

extension TextFirstEditorController {
    /// Sharing reads the current attachment on its I/O queue, after any pending open.
    func readContent() async -> String? {
        if opening, !(await settleOpening()) { return nil }
        guard !closed, let session = attached else { return nil }
        finishComposition()
        return await withCheckedContinuation { done in
            io.async { done.resume(returning: try? session.sourceText()) }
        }
    }

    // MARK: saving (the Store owns the debounce; this only wakes when it says a save is due)

    func markDirty() {
        dirty = true
        armSave()
    }

    func armSave() {
        guard saveTimer == nil, !closed, !savingYielded, !engineBusy,
            let delay = try? session.saveDelay()
        else { return }
        let timer = Timer(timeInterval: max(delay, 0), repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.saveFired() }
        }
        RunLoop.main.add(timer, forMode: .common)
        saveTimer = timer
    }

    func saveFired() {
        saveTimer = nil
        guard !closed else { return }
        runSave({ try $0.saveIfDue() })
    }

    /// A leave began: its registry saves this draft from now on, on its one retry loop. The
    /// timer is cancelled here and `armSave` and `runSave` stay off until `resumeSaving`.
    func yieldSaving() {
        savingYielded = true
        saveTimer?.invalidate()
        saveTimer = nil
    }

    /// A screen took the draft back from its leave: the debounce is its again.
    func resumeSaving() {
        savingYielded = false
        if attached != nil { armSave() }
    }

    /// Write now, ahead of the debounce (the app is going to the background).
    func checkpoint(then done: @escaping () -> Void = {}) {
        guard !closed, !opening, !savingYielded else { return done() }
        saveTimer?.invalidate()
        saveTimer = nil
        finishComposition()
        runSave({ try $0.checkpoint() }, then: done)
    }

    func runSave(
        _ save: @escaping @Sendable (NativeEditorSession) throws -> FlushDraftResult?,
        then done: @escaping () -> Void = {}
    ) {
        guard !savingYielded else { return done() }
        let session = session
        let fence = saveFence
        let epoch = identityEpoch
        io.async { [weak self] in
            // Discarded while this waited its turn: the edits are not written.
            guard !fence.isClosed else {
                DispatchQueue.main.async { MainActor.assumeIsolated { done() } }
                return
            }
            let result = Result { try save(session) }
            // The attachment's own id after the attempt: a peer's rename or a park moved it
            // whether or not the write then succeeded. Read here so the main thread never
            // waits on the session for it. `epoch` orders it against a rename's own adoption.
            let identity = try? session.noteId()
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    self?.saved(result, identity: identity, epoch: epoch)
                    done()
                }
            }
        }
    }

    func saved(_ result: Result<FlushDraftResult?, Error>, identity: String?, epoch: UInt64) {
        // Discarded while this save was in flight: nothing is reported about the draft, but a
        // write that did land is still projected.
        if saveFence.isClosed {
            if case .success(let flushed?) = result { onCheckpoint?(flushed) }
            return
        }
        // On either outcome: a checkpoint settles marked text and prepares an outside write's
        // adoption before the write that may then fail (recovery.md), so the engine's own
        // changes are waiting either way.
        drainCoordinatedChanges()
        if let identity { adoptRead(identity, epoch: epoch) }
        switch result {
        case .success(let flushed):
            if let flushed {
                saveModel.failed = false
                if case .parkedConflict(let id) = flushed.disposition { saveModel.parkedId = id }
                onCheckpoint?(flushed)
            }
        case .failure(let error):
            saveModel.failed = true
            onFailure?(error)
        }
        // What is unsaved is the engine's to say (an adopted merge is not typed text); a
        // running engine job is not interrupted to ask.
        if !engineBusy { dirty = (try? session.saveDelay()) != nil }
        armSave()
    }

    /// Own-action changes the Store queued for this session: a relink after a rename, and a
    /// checkpoint's settling of marked text plus the adoption of an outside write.
    func drainCoordinatedChanges() {
        guard !closed else { return }
        // A running engine job holds the session: take them when it ends (`settleJobs`).
        guard !engineBusy else {
            drainDeferred = !opening
            return
        }
        drainDeferred = false
        do {
            // While the engine itself holds marked text its revision is the view's; the
            // changes wait for the save that follows.
            if try session.composition() != nil { return }
            let changes = try session.takeCoordinatedChanges()
            guard let last = changes.last else { return }
            if engineComposing || textView.markedTextRange != nil {
                // The engine ended the composition to settle these: the marked text is real
                // text there, so show the engine's text and selection (the view's marked
                // range cannot take an incremental edit).
                reloadFromEngine(selecting: last.selection)
                return
            }
            for change in changes {
                guard change.previousRevision == rev else {
                    reloadFromEngine(selecting: last.selection)
                    return
                }
                try accept(change)
            }
        } catch { recover(error, context: "coordinated changes") }
    }

    /// The user chose to lose the unsaved edits: end the attachment without saving. The note
    /// is free to open again once nothing holds this controller.
    func discard() {
        saveFence.close()
        saveTimer?.invalidate()
        saveTimer = nil
        if opening { abandonOpening() }
        closed = true
        images.shutdown()
    }

    /// Save, then release the attachment. A failed detach leaves the session attached.
    func close() async -> Result<FlushDraftResult, Error> {
        // A leave before the engine landed still applies what was typed, then saves it.
        if opening, !(await settleOpening()) {
            closed = true
            images.shutdown()
            return .failure(TextFirstNeverOpened())
        }
        finishComposition()
        saveTimer?.invalidate()
        saveTimer = nil
        let session = session
        let fence = saveFence
        let result: Result<FlushDraftResult, Error> = await withCheckedContinuation { done in
            io.async {
                done.resume(
                    returning: fence.isClosed
                        ? .failure(TextFirstDiscarded()) : Result { try session.detach() })
            }
        }
        switch result {
        case .success(let saved):
            // A save that parked the draft left the attachment on the conflict copy.
            if case .parkedConflict(let parked) = saved.disposition { adoptIdentity(parked) }
            closed = true
            images.shutdown()
        case .failure(let error):
            // The attachment is still the draft: deliver what the failed save changed in
            // it and follow it if it moved. Retrying is the caller's (the leave's loop; the
            // controller's own timer stays off).
            guard !(error is TextFirstDiscarded) else { break }
            drainCoordinatedChanges()
            saveModel.failed = true
        }
        return result
    }
}
