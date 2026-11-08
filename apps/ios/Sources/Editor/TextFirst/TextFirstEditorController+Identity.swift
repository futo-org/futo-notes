#if FUTO_DEBUG_BUILD
    import UIKit

    // The note this editor is attached to. The engine moves an attachment under the editor (a
    // peer's rename, the conflict copy a save parks the draft in, this screen's own rename);
    // the editor follows the engine's id and tells its screen, so titles, navigation and leaves
    // never act on a name the attachment has left.

    extension TextFirstEditorController {
        /// Follow the note the engine has this attachment on. Callers pass an id the engine
        /// reported (the session's own, a returned mutation or disposition), never one derived
        /// from a file name.
        func adoptIdentity(_ id: String) {
            identityEpoch &+= 1
            follow(id)
        }

        /// Follow an id read off the session on the I/O queue after `epoch` was taken. If an
        /// adoption (a rename's committed id, a parked disposition) came in since, the read is
        /// older than it and must not move the editor back: ask the engine again instead.
        func adoptRead(_ id: String, epoch: UInt64) {
            guard epoch == identityEpoch else {
                Task { await refreshIdentity() }
                return
            }
            follow(id)
        }

        private func follow(_ id: String) {
            guard id != noteId else { return }
            noteId = id
            onIdentityChange?(id)
        }

        /// Ask the attachment for its id off the main thread (a save in flight holds the session)
        /// and follow it. Returns the editor's id afterwards. A long note still opening has no
        /// attachment to have moved.
        @discardableResult
        func refreshIdentity() async -> String {
            guard let session = attached else { return noteId }
            let epoch = identityEpoch
            let id: String? = await withCheckedContinuation { done in
                io.async { done.resume(returning: try? session.noteId()) }
            }
            if let id { adoptRead(id, epoch: epoch) }
            return noteId
        }
    }
#endif
