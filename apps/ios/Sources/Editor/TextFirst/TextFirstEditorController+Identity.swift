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
            let id: String? = await withCheckedContinuation { done in
                io.async { done.resume(returning: try? session.noteId()) }
            }
            if let id { adoptIdentity(id) }
            return noteId
        }
    }
#endif
