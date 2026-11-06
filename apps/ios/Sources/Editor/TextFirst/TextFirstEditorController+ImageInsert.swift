#if FUTO_DEBUG_BUILD
    import UIKit

    // Adding an image: the toolbar's Camera and Image items and a pasted image. Every path takes
    // the engine's image claim when the content is chosen (it names this editor session), saves the
    // bytes into the vault through the shared `VaultImages.save`, and presents the claim to
    // `insert_image`. An insertion the engine refuses (the session closed or the note reopened,
    // the caret in code) deletes the file it just saved, so an abandoned insert leaves no blob.

    extension TextFirstEditorController {
        /// Claim this session for an insertion that finishes later; nil when it cannot take one.
        func beginImageInsertion() -> UInt64? {
            guard !closed else { return nil }
            finishComposition()
            return try? session.imageClaim()
        }

        /// Present `claim` with the saved file's name. True when the engine put the image in.
        @discardableResult
        func insertSavedImage(filename: String, claim: UInt64) -> Bool {
            guard !closed, !engineComposing else { return false }
            do {
                guard
                    let change = try session.insertImage(
                        expected: rev, claim: claim, reference: filename, alt: "")
                else { return false }
                try accept(change)
                return true
            } catch EditorSessionError.StaleClaim {
                return false
            } catch {
                print("text-first: insert image refused: \(error)")
                return false
            }
        }

        /// Save `data` into the vault and insert it at `claim`'s session.
        @discardableResult
        func insertImage(data: Data, ext: String, claim: UInt64) async -> Bool {
            guard
                let filename = await VaultImages.save(
                    data: data, preferredExtension: ext, root: imageRoot)
            else {
                return false
            }
            if insertSavedImage(filename: filename, claim: claim) { return true }
            await VaultImages.remove(filename: filename, root: imageRoot)
            return false
        }

        /// The toolbar's Camera and Image items. `source` is the manifest's ("camera", "library").
        func pickImage(source: String) {
            guard let claim = beginImageInsertion() else { return }
            // The camera can cost the app its memory; leave nothing unsaved behind.
            if source == "camera" { checkpoint() }
            ImagePicker.present(source: source) { [weak self] picked in
                guard let self, let first = picked.first else { return }
                Task { @MainActor in
                    await self.insertImage(data: first.data, ext: first.ext, claim: claim)
                }
            }
        }

        /// A paste whose only content is an image. False when the pasteboard holds text too (that
        /// stays an ordinary text paste) or no image.
        func pasteImageFromPasteboard() -> Bool {
            let pasteboard = UIPasteboard.general
            guard !closed, pasteboard.hasImages, !pasteboard.hasStrings,
                let (data, ext) = VaultImages.pasteboardImage()
            else { return false }
            // A closed session or the caret in code refuses it without writing a file; the claim
            // is taken now, so the image lands in the note it was pasted into.
            guard let claim = beginImageInsertion() else { return true }
            Task { @MainActor in await self.insertImage(data: data, ext: ext, claim: claim) }
            return true
        }
    }
#endif
