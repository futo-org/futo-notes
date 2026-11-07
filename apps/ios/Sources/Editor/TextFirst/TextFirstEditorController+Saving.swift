#if FUTO_DEBUG_BUILD
    import UIKit

    extension TextFirstEditorController {
        // MARK: saving (the Store owns the debounce; this only wakes when it says a save is due)

        func markDirty() {
            dirty = true
            armSave()
        }

        func armSave() {
            guard saveTimer == nil, !closed, !engineBusy, let delay = try? session.saveDelay()
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

        /// Write now, ahead of the debounce (the app is going to the background).
        func checkpoint(then done: @escaping () -> Void = {}) {
            guard !closed, !opening else { return done() }
            saveTimer?.invalidate()
            saveTimer = nil
            finishComposition()
            runSave({ try $0.checkpoint() }, then: done)
        }

        func runSave(
            _ save: @escaping @Sendable (NativeEditorSession) throws -> FlushDraftResult?,
            then done: @escaping () -> Void = {}
        ) {
            let session = session
            io.async { [weak self] in
                let result = Result { try save(session) }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self?.saved(result)
                        done()
                    }
                }
            }
        }

        func saved(_ result: Result<FlushDraftResult?, Error>) {
            // On either outcome: a checkpoint settles marked text and prepares an outside write's
            // adoption before the write that may then fail (recovery.md), so the engine's own
            // changes are waiting either way.
            drainCoordinatedChanges()
            switch result {
            case .success(let flushed):
                if let flushed { onCheckpoint?(flushed) }
            case .failure(let error):
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
            let result: Result<FlushDraftResult, Error> = await withCheckedContinuation { done in
                io.async { done.resume(returning: Result { try session.detach() }) }
            }
            switch result {
            case .success:
                closed = true
                images.shutdown()
            case .failure:
                // The attachment is still the draft: deliver what the failed save changed in
                // it, and keep the retry going.
                drainCoordinatedChanges()
                armSave()
            }
            return result
        }
    }
#endif
