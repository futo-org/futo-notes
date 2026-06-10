import Foundation
import UIKit
import WebKit
import PhotosUI
import UniformTypeIdentifiers

// Local-image plumbing for the embedded editor:
//   - FutoAssetSchemeHandler serves GET futo-asset:///<filename> from the vault
//     root so ![](photo.png) renders inside the WKWebView.
//   - VaultImages saves picked image bytes into the vault root under a unique
//     generated filename.
//   - ImagePicker presents the native camera / photo-library picker for the
//     bridge's {type:'pickImage'} message.

/// Image extensions the vault serves and accepts. Hardcoded copy of
/// `IMAGE_EXTENSIONS` in @futo-notes/shared (packages/shared/src/sync.ts) —
/// keep in lockstep; there is no Swift binding for the shared TS package.
private let futoImageExtensions: Set<String> = [
    "jpg", "jpeg", "png", "gif", "webp", "svg", "bmp", "ico", "avif", "heic",
]

// MARK: - futo-asset:// scheme

/// Serves `futo-asset:///<filename>` from the vault root. Flat filenames only:
/// anything with a path separator or `..` is rejected (path-traversal guard),
/// as is any non-image extension. Registered on the shared editor WKWebView's
/// configuration (EditorHost); the editor resolves local image filenames via
/// `setImageBaseUrl('futo-asset:///')`.
final class FutoAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "futo-asset"

    /// Tasks WebKit has stopped — calling didReceive/didFinish on one throws.
    /// Scheme-handler callbacks arrive on the main thread; the file read hops
    /// off and re-checks this set back on main before responding.
    private var stopped = Set<ObjectIdentifier>()
    private lazy var root = NotesStore.resolveNotesRoot()

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            fail(urlSchemeTask)
            return
        }
        // futo-asset:///my%20pic.png → url.path is the percent-DECODED
        // "/my pic.png"; drop the leading slash to get the bare filename.
        let filename = String(url.path.dropFirst())
        guard !filename.isEmpty, !filename.contains("/"), !filename.contains("..") else {
            fail(urlSchemeTask)
            return
        }
        guard let mime = VaultImages.mimeType(for: filename) else {
            fail(urlSchemeTask) // not an allowed image extension
            return
        }
        let fileURL = root.appendingPathComponent(filename)
        let id = ObjectIdentifier(urlSchemeTask)
        DispatchQueue.global(qos: .userInitiated).async {
            let data = try? Data(contentsOf: fileURL)
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.stopped.remove(id) != nil { return }
                guard let data else {
                    self.fail(urlSchemeTask)
                    return
                }
                let response = URLResponse(
                    url: url, mimeType: mime,
                    expectedContentLength: data.count, textEncodingName: nil)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stopped.insert(ObjectIdentifier(urlSchemeTask))
    }

    private func fail(_ task: WKURLSchemeTask) {
        task.didFailWithError(URLError(.fileDoesNotExist))
    }
}

// MARK: - Saving picked images into the vault

enum VaultImages {
    /// Content-Type for an allowed image filename, or nil when the extension is
    /// not in the shared image list (which doubles as the serve allow-list).
    static func mimeType(for filename: String) -> String? {
        let ext = (filename as NSString).pathExtension.lowercased()
        guard futoImageExtensions.contains(ext) else { return nil }
        switch ext {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "svg": return "image/svg+xml"
        case "bmp": return "image/bmp"
        case "ico": return "image/x-icon"
        case "avif": return "image/avif"
        case "heic": return "image/heic"
        default: return nil
        }
    }

    /// Save picked image bytes into the vault root under a generated unique
    /// filename (image-<timestamp>[-n].<ext>). Returns the bare filename — what
    /// `![](…)` references — or nil on write failure. Extensions outside the
    /// shared image list are coerced to jpg (the pickers only ever hand us
    /// known formats; this is belt-and-suspenders). Runs off-main.
    static func save(data: Data, preferredExtension: String) async -> String? {
        let lowered = preferredExtension.lowercased()
        let ext = futoImageExtensions.contains(lowered) ? lowered : "jpg"
        let root = NotesStore.resolveNotesRoot()
        return await Task.detached(priority: .userInitiated) { () -> String? in
            let fm = FileManager.default
            try? fm.createDirectory(at: root, withIntermediateDirectories: true)
            let formatter = DateFormatter()
            formatter.dateFormat = "yyyyMMdd-HHmmss"
            let base = "image-\(formatter.string(from: Date()))"
            var name = "\(base).\(ext)"
            var n = 2
            while fm.fileExists(atPath: root.appendingPathComponent(name).path) {
                name = "\(base)-\(n).\(ext)"
                n += 1
            }
            do {
                try data.write(to: root.appendingPathComponent(name), options: .atomic)
                return name
            } catch {
                print("VaultImages.save failed: \(error)")
                return nil
            }
        }.value
    }
}

// MARK: - Native pickers

/// Presents the native image pickers for the bridge's `pickImage` message.
/// 'library' → PHPickerViewController (images only, no permission prompt);
/// 'camera' → UIImagePickerController(.camera), gracefully falling back to the
/// library picker where no camera exists (simulator). Presented from the top
/// view controller (UIKit bridge out of the SwiftUI context).
@MainActor
enum ImagePicker {
    /// Strong ref to the in-flight delegate while a picker is presented (UIKit
    /// picker delegates are weak). Single picker at a time.
    private static var activeDelegate: AnyObject?

    /// Completion delivers raw image bytes + a preferred file extension on the
    /// main thread, or nil data when the user cancelled.
    static func present(source: String, completion: @escaping (Data?, String) -> Void) {
        guard let top = topViewController() else {
            completion(nil, "jpg")
            return
        }
        let finish: (Data?, String) -> Void = { data, ext in
            activeDelegate = nil
            completion(data, ext)
        }
        if source == "camera", UIImagePickerController.isSourceTypeAvailable(.camera) {
            let delegate = CameraDelegate(completion: finish)
            activeDelegate = delegate
            let picker = UIImagePickerController()
            picker.sourceType = .camera
            picker.delegate = delegate
            top.present(picker, animated: true)
        } else {
            // 'library' — or camera requested but unavailable (simulator).
            var config = PHPickerConfiguration()
            config.filter = .images
            config.selectionLimit = 1
            let delegate = LibraryDelegate(completion: finish)
            activeDelegate = delegate
            let picker = PHPickerViewController(configuration: config)
            picker.delegate = delegate
            top.present(picker, animated: true)
        }
    }

    /// Walk to the top-most presented view controller of the key window.
    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard var top = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController
        else { return nil }
        while let presented = top.presentedViewController {
            top = presented
        }
        return top
    }
}

/// PHPicker delegate: prefer the original bytes (keeps format) for formats we
/// recognize; otherwise re-encode through UIImage as JPEG.
private final class LibraryDelegate: NSObject, PHPickerViewControllerDelegate {
    private let completion: (Data?, String) -> Void

    init(completion: @escaping (Data?, String) -> Void) {
        self.completion = completion
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else {
            completion(nil, "jpg") // cancelled
            return
        }
        if let (typeId, ext) = preferredType(for: provider) {
            provider.loadDataRepresentation(forTypeIdentifier: typeId) { data, _ in
                DispatchQueue.main.async {
                    if let data {
                        self.completion(data, ext)
                    } else {
                        self.loadAsJpeg(provider)
                    }
                }
            }
        } else {
            loadAsJpeg(provider)
        }
    }

    /// First registered type identifier that maps to one of our image
    /// extensions (provider order = the asset's preferred representation).
    private func preferredType(for provider: NSItemProvider) -> (String, String)? {
        for typeId in provider.registeredTypeIdentifiers {
            if let ext = imageExt(forTypeId: typeId) {
                return (typeId, ext)
            }
        }
        return nil
    }

    private func imageExt(forTypeId typeId: String) -> String? {
        switch typeId {
        case UTType.jpeg.identifier: return "jpg"
        case UTType.png.identifier: return "png"
        case UTType.gif.identifier: return "gif"
        case UTType.webP.identifier: return "webp"
        case UTType.heic.identifier: return "heic"
        case UTType.bmp.identifier: return "bmp"
        default: return nil
        }
    }

    private func loadAsJpeg(_ provider: NSItemProvider) {
        guard provider.canLoadObject(ofClass: UIImage.self) else {
            completion(nil, "jpg")
            return
        }
        provider.loadObject(ofClass: UIImage.self) { object, _ in
            let data = (object as? UIImage)?.jpegData(compressionQuality: 0.9)
            DispatchQueue.main.async {
                self.completion(data, "jpg")
            }
        }
    }
}

/// Camera capture delegate — always hands back JPEG bytes.
private final class CameraDelegate: NSObject, UIImagePickerControllerDelegate,
    UINavigationControllerDelegate
{
    private let completion: (Data?, String) -> Void

    init(completion: @escaping (Data?, String) -> Void) {
        self.completion = completion
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        let image = info[.originalImage] as? UIImage
        completion(image?.jpegData(compressionQuality: 0.9), "jpg")
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        completion(nil, "jpg")
    }
}
