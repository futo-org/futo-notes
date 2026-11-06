#if FUTO_DEBUG_BUILD
    import Foundation

    /// A note has one editor attachment, so opening it again waits for the previous screen's
    /// leave (save + detach) to finish. A leave whose detach failed keeps its controller and
    /// retries, so a failed save is never dropped.
    @MainActor
    enum TextFirstLeaves {
        private static var inflight: [String: Task<Void, Never>] = [:]

        static func awaitLeave(of id: String) async {
            await inflight[id]?.value
        }

        static func leave(
            id: String, controller: TextFirstEditorController, store: NotesStore,
            discardIfEmpty: Bool, release: @escaping () -> Void
        ) {
            let previous = inflight[id]
            inflight[id] = Task { @MainActor in
                await previous?.value
                var attempts = 0
                while true {
                    switch await controller.close() {
                    case .success(let saved):
                        if let mutation = saved.mutation { store.applyEditorMutation(mutation) }
                        if discardIfEmpty, controller.isEmpty {
                            _ = await store.delete(controller.noteId)
                        }
                        release()
                        return
                    case .failure(let error) where error is TextFirstNeverOpened:
                        release()
                        return
                    case .failure(let error):
                        attempts += 1
                        print("text-first: detach \(id) failed (\(attempts)): \(error)")
                        guard attempts < 10 else {
                            release()
                            return
                        }
                        try? await Task.sleep(nanoseconds: 2_000_000_000)
                    }
                }
            }
        }
    }

    extension TextFirstEditorController {
        var isEmpty: Bool { mirrorLength == 0 }
    }
#endif
