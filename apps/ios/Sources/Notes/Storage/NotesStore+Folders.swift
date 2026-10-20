import Foundation

extension NotesStore {
    func deleteFolder(_ folder: String) {
        let epoch = resetEpoch
        guard !resetting else { return }
        let previous = folderMutationTail
        folderMutationTail = Task {
            await previous?.value
            guard !resetting else { return }
            do {
                applyMutation(
                    try await vault.deleteFolder(folder, epoch: epoch), expectedEpoch: epoch)
                onLocalChange?()
            } catch {
                print("deleteFolder failed for \(folder): \(error)")
            }
        }
    }

    func createFolder(_ path: String) {
        let epoch = resetEpoch
        guard !resetting else { return }
        let previous = folderMutationTail
        folderMutationTail = Task {
            await previous?.value
            guard !resetting else { return }
            do {
                applyMutation(
                    try await vault.createFolder(path, epoch: epoch), expectedEpoch: epoch)
                onLocalChange?()
            } catch {
                print("createFolder failed for \(path): \(error)")
            }
        }
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

    func notes(in folder: String) -> [NoteItem] {
        notes.filter { $0.folder == folder }
    }

    func notePath(_ id: String) -> String {
        notesRoot.appendingPathComponent(id + ".md").path
    }
}
