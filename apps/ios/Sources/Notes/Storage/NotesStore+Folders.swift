import Foundation

extension NotesStore {
    /// Returns once the folder list has the change, and whether it landed.
    @discardableResult
    func deleteFolder(_ folder: String) async -> Bool {
        await deleteFolderKeepingNotes(folder) != nil
    }

    /// Deletes the folder and moves its notes up a level. Returns the moved notes' final ids
    /// once the lists have the change, or nil when it did not land.
    func deleteFolderKeepingNotes(_ folder: String) async -> [String]? {
        await folderMutation("deleteFolder failed for \(folder)") { [vault] epoch in
            try await vault.deleteFolder(folder, epoch: epoch)
        }?.upserted.map(\.note.id)
    }

    /// Permanently deletes every note under the folder (subfolders included) and then the
    /// folder. Returns once the lists have the change, and whether it landed.
    @discardableResult
    func deleteFolderAndNotes(_ folder: String) async -> Bool {
        await serializedFolderMutation("deleteFolderAndNotes failed for \(folder)") {
            [vault] epoch in
            try await vault.deleteFolderAndNotes(folder, epoch: epoch)
        }
    }

    /// Returns once the folder list has the change, and whether it landed.
    @discardableResult
    func createFolder(_ path: String) async -> Bool {
        await serializedFolderMutation("createFolder failed for \(path)") { [vault] epoch in
            try await vault.createFolder(path, epoch: epoch)
        }
    }

    /// Runs one folder mutation after the previous one settles, under the epoch it was asked
    /// in; `failure` prefixes the log line when it throws.
    private func serializedFolderMutation(
        _ failure: String, _ mutate: @escaping (UInt64) async throws -> NoteMutation
    ) async -> Bool {
        await folderMutation(failure, mutate) != nil
    }

    /// `serializedFolderMutation`, returning the applied mutation (nil when it did not land).
    private func folderMutation(
        _ failure: String, _ mutate: @escaping (UInt64) async throws -> NoteMutation
    ) async -> NoteMutation? {
        let epoch = resetEpoch
        guard !resetting else { return nil }
        let previous = folderMutationTail
        let mutation = Task { () -> NoteMutation? in
            _ = await previous?.value
            guard !resetting else { return nil }
            do {
                let applied = try await mutate(epoch)
                applyMutation(applied, expectedEpoch: epoch)
                onLocalChange?()
                return applied
            } catch {
                print("\(failure): \(error)")
                return nil
            }
        }
        folderMutationTail = mutation
        return await mutation.value
    }

    func renameFolder(from: String, to: String) async -> String? {
        let epoch = resetEpoch
        guard !resetting else { return nil }
        do {
            let mutation = try await vault.renameFolder(from: from, to: to, epoch: epoch)
            applyMutation(mutation, expectedEpoch: epoch)
            onLocalChange?()
            return mutation.finalFolder ?? to
        } catch {
            print("renameFolder failed \(from) -> \(to): \(error)")
            return nil
        }
    }

    func moveFolder(from: String, destinationParent: String) async -> String? {
        let epoch = resetEpoch
        guard !resetting else { return nil }
        do {
            let mutation = try await vault.moveFolder(
                from: from, destinationParent: destinationParent, epoch: epoch)
            applyMutation(mutation, expectedEpoch: epoch)
            onLocalChange?()
            return mutation.finalFolder ?? from
        } catch {
            print("moveFolder failed \(from) -> \(destinationParent): \(error)")
            return nil
        }
    }

    func subfolders(of folder: String) -> [String] {
        let prefix = folder.isEmpty ? "" : folder + "/"
        return folders.filter { path in
            guard path.hasPrefix(prefix) else { return false }
            let tail = String(path.dropFirst(prefix.count))
            return !tail.isEmpty && !tail.contains("/")
        }
    }

    /// Every note in the folder or any folder beneath it, in list order.
    func notes(under folder: String) -> [NoteItem] {
        let prefix = folder + "/"
        return notes.filter { $0.folder == folder || $0.folder.hasPrefix(prefix) }
    }

    func notes(in folder: String) -> [NoteItem] {
        notes.filter { $0.folder == folder }
    }

    func notePath(_ id: String) -> String {
        notesRoot.appendingPathComponent(id + ".md").path
    }
}
