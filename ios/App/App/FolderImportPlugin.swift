import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(FolderImportPlugin)
public class FolderImportPlugin: CAPPlugin, UIDocumentPickerDelegate {
    private var savedCall: CAPPluginCall?

    @objc func pickAndReadMarkdownFiles(_ call: CAPPluginCall) {
        savedCall = call

        DispatchQueue.main.async {
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = savedCall, let url = urls.first else {
            savedCall?.reject("No folder selected")
            savedCall = nil
            return
        }

        guard url.startAccessingSecurityScopedResource() else {
            call.reject("Cannot access folder")
            savedCall = nil
            return
        }

        defer {
            url.stopAccessingSecurityScopedResource()
        }

        var files: [[String: String]] = []
        enumerateAndRead(directory: url, baseDirectory: url, files: &files)

        call.resolve(["files": files])
        savedCall = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        savedCall?.reject("Folder selection cancelled")
        savedCall = nil
    }

    private func enumerateAndRead(directory: URL, baseDirectory: URL, files: inout [[String: String]]) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for item in contents {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false

            if isDir {
                enumerateAndRead(directory: item, baseDirectory: baseDirectory, files: &files)
            } else if item.pathExtension == "md" {
                if let content = try? String(contentsOf: item, encoding: .utf8) {
                    let name = item.deletingPathExtension().lastPathComponent
                    let dirPath = directory.path.replacingOccurrences(of: baseDirectory.path, with: "")
                    let relativePath = dirPath.hasPrefix("/") ? String(dirPath.dropFirst()) : dirPath
                    files.append(["name": name, "path": relativePath, "content": content])
                }
            }
        }
    }
}
