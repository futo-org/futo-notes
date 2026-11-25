import SwiftUI

extension TextFirstNoteScreen {
    /// Drain the admitted title work and settle input before using the existing store action.
    /// The store retargets or terminates the attachment atomically with its file mutation.
    func performNoteAction(
        _ action: @escaping (TextFirstEditorController) async -> Bool
    ) -> Task<Bool, Never>? {
        guard let controller, !controller.opening, !controller.engineBusy, !actionBusy, !leaving
        else {
            return nil
        }
        actionBusy = true
        controller.textView.resignFirstResponder()
        controller.finishComposition()
        let pendingRename = renameTask
        let task = Task { @MainActor in
            await pendingRename?.value
            defer { actionBusy = false }
            return await action(controller)
        }
        actionTask = Task { _ = await task.value }
        return task
    }
}
