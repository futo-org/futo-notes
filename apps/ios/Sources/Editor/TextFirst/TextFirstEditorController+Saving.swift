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
            switch result {
            case .success(let flushed):
                if let flushed {
                    dirty = false
                    onCheckpoint?(flushed)
                    drainCoordinatedChanges()
                }
            case .failure(let error):
                onFailure?(error)
            }
            armSave()
        }

        /// Own-action changes (a relink after a rename) the Store queued for this session.
        func drainCoordinatedChanges() {
            guard !closed, !engineBusy, !engineComposing else { return }
            do {
                for change in try session.takeCoordinatedChanges() {
                    guard change.previousRevision == rev else {
                        reloadFromEngine()
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
            case .failure: armSave()
            }
            return result
        }
    }
#endif
