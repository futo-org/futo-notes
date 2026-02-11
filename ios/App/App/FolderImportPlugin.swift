import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(FolderImportPlugin)
public class FolderImportPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "FolderImportPlugin"
    public let jsName = "FolderImport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickAndReadMarkdownFiles", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setFileModificationTime", returnType: CAPPluginReturnPromise)
    ]

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

        var files: [[String: Any]] = []
        enumerateAndRead(directory: url, baseDirectory: url, files: &files)

        call.resolve(["files": files])
        savedCall = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        savedCall?.reject("Folder selection cancelled")
        savedCall = nil
    }

    @objc func setFileModificationTime(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"),
              let mtime = call.getDouble("mtime") else {
            call.reject("Missing filename or mtime")
            return
        }

        let fm = FileManager.default
        guard let docsDir = fm.urls(for: .documentDirectory, in: .userDomainMask).first else {
            call.reject("Cannot access Documents directory")
            return
        }

        let filePath = docsDir.appendingPathComponent("futo-notes").appendingPathComponent(filename).path
        let date = Date(timeIntervalSince1970: mtime / 1000.0)

        do {
            try fm.setAttributes([.modificationDate: date], ofItemAtPath: filePath)
            call.resolve()
        } catch {
            call.reject("Failed to set modification time: \(error.localizedDescription)")
        }
    }

    private func enumerateAndRead(directory: URL, baseDirectory: URL, files: inout [[String: Any]]) {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for item in contents {
            let resourceValues = try? item.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey])
            let isDir = resourceValues?.isDirectory ?? false

            if isDir {
                enumerateAndRead(directory: item, baseDirectory: baseDirectory, files: &files)
            } else if item.pathExtension == "md" {
                if let content = try? String(contentsOf: item, encoding: .utf8) {
                    let name = item.deletingPathExtension().lastPathComponent
                    let dirPath = directory.path.replacingOccurrences(of: baseDirectory.path, with: "")
                    let relativePath = dirPath.hasPrefix("/") ? String(dirPath.dropFirst()) : dirPath
                    var entry: [String: Any] = ["name": name, "path": relativePath, "content": content]
                    if let modDate = resourceValues?.contentModificationDate {
                        entry["lastModified"] = modDate.timeIntervalSince1970 * 1000.0
                    }
                    files.append(entry)
                }
            }
        }
    }
}
