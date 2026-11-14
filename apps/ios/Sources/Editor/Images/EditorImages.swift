import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// Image extensions accepted by the Rust vault rules.
private let futoImageExtensions = Set(imageExtensions())

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

    /// Image bytes + preferred extension from the system pasteboard, or nil when it holds no
    /// image. Prefers the raw PNG/JPEG representation (preserves the source format, as the
    /// picker does), falling back to UIImage -> PNG.
    static func pasteboardImage() -> (Data, String)? {
        let pasteboard = UIPasteboard.general
        if let png = pasteboard.data(forPasteboardType: UTType.png.identifier) {
            return (png, "png")
        }
        if let jpeg = pasteboard.data(forPasteboardType: UTType.jpeg.identifier) {
            return (jpeg, "jpg")
        }
        if let image = pasteboard.image, let png = image.pngData() {
            return (png, "png")
        }
        return nil
    }

    /// Save picked image bytes into the vault root under a generated unique
    /// filename (image-<timestamp>[-n].<ext>). Returns the bare filename — what
    /// `![](…)` references — or nil on write failure. Extensions outside the
    /// shared image list are coerced to jpg (the pickers only ever hand us
    /// known formats; this is belt-and-suspenders). Runs off-main.
    static func save(
        data: Data, preferredExtension: String, root: URL = NotesStore.resolveNotesRoot()
    ) async -> String? {
        let lowered = preferredExtension.lowercased()
        let ext = futoImageExtensions.contains(lowered) ? lowered : "jpg"
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

    /// Remove a generated image whose asynchronous editor attachment went
    /// stale before insertion. The bare-name and extension checks keep this
    /// cleanup narrower than the scheme handler's already-flat asset surface.
    static func remove(filename: String, root: URL = NotesStore.resolveNotesRoot()) async {
        guard (filename as NSString).lastPathComponent == filename,
            mimeType(for: filename) != nil
        else { return }
        await Task.detached(priority: .utility) {
            do {
                try FileManager.default.removeItem(at: root.appendingPathComponent(filename))
            } catch  where (error as NSError).code == NSFileNoSuchFileError {
                return
            } catch {
                print("VaultImages.remove failed: \(error)")
            }
        }.value
    }
}

// MARK: - Native pickers

struct PickedImage {
    let data: Data
    let ext: String
}

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

    /// Completion is delivered on the main thread.
    static func present(
        source: String, limit: Int = 1, completion: @escaping ([PickedImage]) -> Void
    ) {
        guard let top = topViewController() else {
            completion([])
            return
        }
        let finish: ([PickedImage]) -> Void = { images in
            activeDelegate = nil
            completion(images)
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
            config.selectionLimit = max(1, limit)
            // `.default` reports results in library order, not tap order.
            config.selection = .ordered
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
    private let completion: ([PickedImage]) -> Void

    init(completion: @escaping ([PickedImage]) -> Void) {
        self.completion = completion
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard !results.isEmpty else {
            completion([])  // canceled
            return
        }
        let slots = PickedImageSlots(count: results.count)
        let group = DispatchGroup()
        for (index, result) in results.enumerated() {
            group.enter()
            load(result.itemProvider) { image in
                slots.put(image, at: index)
                group.leave()
            }
        }
        group.notify(queue: .main) { [completion] in
            completion(slots.ordered())
        }
    }

    private func load(_ provider: NSItemProvider, _ done: @escaping (PickedImage?) -> Void) {
        guard let (typeId, ext) = preferredType(for: provider) else {
            loadAsJpeg(provider, done)
            return
        }
        provider.loadDataRepresentation(forTypeIdentifier: typeId) { [weak self] data, _ in
            if let data {
                done(PickedImage(data: data, ext: ext))
            } else {
                self?.loadAsJpeg(provider, done) ?? done(nil)
            }
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

    private func loadAsJpeg(_ provider: NSItemProvider, _ done: @escaping (PickedImage?) -> Void) {
        guard provider.canLoadObject(ofClass: UIImage.self) else {
            done(nil)
            return
        }
        provider.loadObject(ofClass: UIImage.self) { object, _ in
            guard let data = (object as? UIImage)?.jpegData(compressionQuality: 0.9) else {
                done(nil)
                return
            }
            done(PickedImage(data: data, ext: "jpg"))
        }
    }
}

final class PickedImageSlots {
    private let lock = NSLock()
    private var slots: [PickedImage?]

    init(count: Int) {
        slots = Array(repeating: nil, count: count)
    }

    func put(_ image: PickedImage?, at index: Int) {
        lock.lock()
        slots[index] = image
        lock.unlock()
    }

    func ordered() -> [PickedImage] {
        lock.lock()
        defer { lock.unlock() }
        return slots.compactMap { $0 }
    }
}

/// Camera capture delegate — always hands back JPEG bytes.
private final class CameraDelegate: NSObject, UIImagePickerControllerDelegate,
    UINavigationControllerDelegate
{
    private let completion: ([PickedImage]) -> Void

    init(completion: @escaping ([PickedImage]) -> Void) {
        self.completion = completion
    }

    func imagePickerController(
        _ picker: UIImagePickerController,
        didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
        picker.dismiss(animated: true)
        guard let data = (info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9)
        else {
            completion([])
            return
        }
        completion([PickedImage(data: data, ext: "jpg")])
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        picker.dismiss(animated: true)
        completion([])
    }
}
