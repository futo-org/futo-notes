import UIKit

enum FeedbackImages {
    static let maxBytes = 5 * 1024 * 1024
    static let jpegQuality: CGFloat = 0.95
    static let maxAttachments = 3

    private static let serverAccepted: Set<String> = ["png", "jpg", "jpeg", "webp"]

    static func needsTranscode(ext: String, byteCount: Int) -> Bool {
        !serverAccepted.contains(ext.lowercased()) || byteCount > maxBytes
    }

    static func normalize(_ picked: PickedImage) -> Data? {
        guard needsTranscode(ext: picked.ext, byteCount: picked.data.count) else {
            return picked.data
        }
        guard let image = UIImage(data: picked.data),
            let jpeg = image.jpegData(compressionQuality: jpegQuality),
            jpeg.count <= maxBytes
        else { return nil }
        return jpeg
    }
}
