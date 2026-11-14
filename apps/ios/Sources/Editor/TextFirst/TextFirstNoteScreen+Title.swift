import SwiftUI

extension TextFirstNoteScreen {
    func titleChanged(_ cleaned: String) {
        titleDuplicate = false
        renameTask?.cancel()
        renameTask = Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled, !leaving else { return }
            await renameTo(cleaned)
        }
    }

    /// Rename the attached note to the typed title (see `TextFirstTitle`).
    func renameTo(_ raw: String) async {
        guard let controller else { return }
        switch await TextFirstTitle.rename(
            to: raw, controller: controller, store: store, ownerToken: ownerToken)
        {
        case .unchanged:
            break
        case .duplicate:
            if titleField == raw { titleDuplicate = true }
        case .renamed(let id):
            if titleField == raw { titleField = splitId(id: id).title }
        case .failed:
            store.showTransient(LocalizedMessage("notes.title.renameFailed"))
        }
    }
}
