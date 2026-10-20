import UIKit
import UniformTypeIdentifiers
import WebKit

extension EditorHost {
    /// Image bytes + preferred extension from the system pasteboard, or nil when
    /// it holds no image. Prefers the raw PNG/JPEG representation (preserves the
    /// source format, as the picker does), falling back to UIImage → PNG.
    func clipboardImageData() -> (Data, String)? {
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

    /// Bridge 'pickImage': camera or library picker (camera falls back to the
    /// library on devices/simulators without one), save into the vault root
    /// honoring the shared image-extension rules, then insertImage(filename).
    func presentImagePicker(source: String) {
        let targetGeneration = generation
        completionQueue.enqueue { [weak self] in
            guard let self else { return }
            let picked: [PickedImage] = await withCheckedContinuation { continuation in
                ImagePicker.present(source: source) { continuation.resume(returning: $0) }
            }
            guard let image = picked.first else { return }
            guard
                let filename = await VaultImages.save(
                    data: image.data, preferredExtension: image.ext)
            else { return }
            let inserted = await self.insertImage(filename, for: targetGeneration)
            if !inserted {
                await VaultImages.remove(filename: filename)
            }
        }
    }

    /// Native toolbar tap → bridge. `exec` runs the shared markdownToolbar.ts
    /// command for the item's manifest id; pickImage opens the native picker
    /// (same path the web toolbar's bridge message takes); dismiss blurs the
    /// editor through the bridge so the page's focus state stays truthful
    /// (the resulting keyboard drop hides this accessory too).
    func performToolbarAction(_ item: ToolbarItemSpec) {
        switch item.action {
        case .exec:
            exec(item.id)
        case .pickImage(let source):
            presentImagePicker(source: source)
        case .dismiss:
            blur()
        }
    }

    func openEditorURLExternally(_ url: URL) {
        guard
            case .openExternally(let safeURL) = editorNavigationDecision(
                for: url,
                isMainFrame: true,
                permittedFileURL: editorFileURL
            )
        else { return }
        UIApplication.shared.open(safeURL)
    }
}
