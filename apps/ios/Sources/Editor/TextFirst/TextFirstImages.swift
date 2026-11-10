#if FUTO_DEBUG_BUILD
    import ImageIO
    import CoreText
    import UIKit

    // Images in the text-first editor. The engine keeps an image's `![alt](destination)` spelling
    // in the display text and reports it as an atom (`EditorStyleSpan.image`); this draws it as one
    // unit. The glyphs stay in the text but are hidden (a 0.01 pt clear font); the first glyph
    // carries a kern as wide as the image so the words after it flow past, and the paragraph's
    // minimum line height is the image's height. The bitmap itself is drawn by the layout fragment.
    // A destination is only ever loaded for display; the engine never reads image files and the
    // Markdown is never rewritten.

    extension NSAttributedString.Key {
        /// A `TextFirstImageSpan` on every glyph of one image atom (one object per occurrence).
        static let tfImage = NSAttributedString.Key("futo.tf.image")
    }

    /// What one destination looks like right now. Shared by every occurrence of the destination.
    final class TextFirstImageAtom {
        let destination: String
        let alt: String
        let vault: Bool
        let remote: Bool
        var image: UIImage?
        /// Pixel width of the bitmap that was decoded (it may be smaller than the file's).
        var decodedPixelWidth = 0
        /// The file's own pixel width, once known.
        var naturalPixelWidth = 0
        var loading = false
        var failedAt: Date?
        var failed: Bool { image == nil && failedAt != nil }

        init(destination: String, alt: String, vault: Bool, remote: Bool) {
            (self.destination, self.alt, self.vault, self.remote) = (
                destination, alt, vault, remote
            )
        }
    }

    /// One image in the text; its identity (not its destination) delimits the atom's glyph run.
    final class TextFirstImageSpan: NSObject {
        let atom: TextFirstImageAtom
        /// The size the last layout pass reserved for it.
        var size = CGSize.zero
        init(_ atom: TextFirstImageAtom) { self.atom = atom }
    }

    enum TextFirstImageMetrics {
        static let loadingHeight: CGFloat = 48
        static let failedHeight: CGFloat = 28
        static let hiddenFont = UIFont.systemFont(ofSize: 0.01)

        static func textAdvance(_ text: String) -> CGFloat {
            let line = CTLineCreateWithAttributedString(
                NSAttributedString(
                    string: text, attributes: [.font: hiddenFont]))
            return CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        }

        /// The size an atom is drawn at in `available` points of width.
        static func size(of atom: TextFirstImageAtom, available: CGFloat) -> CGSize {
            let limit = max(1, available)
            guard let image = atom.image, image.size.width > 0 else {
                return CGSize(width: limit, height: atom.failed ? failedHeight : loadingHeight)
            }
            let width = min(limit, image.size.width)
            return CGSize(
                width: width, height: (image.size.height * width / image.size.width).rounded())
        }
    }

    /// A decoded bitmap and its file's own pixel width (a wider view decodes it again).
    final class TextFirstCachedBitmap {
        let image: UIImage
        let natural: Int
        init(_ image: UIImage, natural: Int) {
            self.image = image
            self.natural = natural
        }
    }

    /// Decodes vault and remote images off the main thread, downsampled to the display width.
    final class TextFirstImageLoader: @unchecked Sendable {
        private static let cache: NSCache<NSString, TextFirstCachedBitmap> = {
            let c = NSCache<NSString, TextFirstCachedBitmap>()
            c.totalCostLimit = 96 * 1024 * 1024
            return c
        }()
        private let queue: OperationQueue = {
            let q = OperationQueue()
            q.name = "futo.textfirst.images"
            q.qualityOfService = .utility
            q.maxConcurrentOperationCount = 3
            return q
        }()
        /// Ephemeral: no cookies, no URL cache, no custom persistent cache (offline shows the
        /// placeholder). Platform TLS verification.
        private let session: URLSession
        private static func makeSession(protocols: [AnyClass]?) -> URLSession {
            let c = URLSessionConfiguration.ephemeral
            if let protocols { c.protocolClasses = protocols }
            c.urlCache = nil
            c.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            c.timeoutIntervalForRequest = 20
            return URLSession(configuration: c)
        }
        let root: URL
        private let scale: CGFloat
        private var cancelled = false

        init(root: URL, scale: CGFloat, protocols: [AnyClass]? = nil) {
            session = Self.makeSession(protocols: protocols)
            self.root = root.standardizedFileURL.resolvingSymlinksInPath()
            self.scale = scale
        }

        func cancel() {
            cancelled = true
            session.invalidateAndCancel()
            queue.cancelAllOperations()
        }

        /// The cache is process-wide: a vault image is keyed by its file and that file's size and
        /// modification date, so another vault's image of the same name, or a replaced file, is
        /// never shown from it. A remote image by its address.
        private func key(_ atom: TextFirstImageAtom, _ width: Int) -> NSString {
            guard atom.vault else { return "\(atom.destination)@\(width)" as NSString }
            guard let file = resolve(atom.destination),
                let attributes = try? FileManager.default.attributesOfItem(atPath: file.path)
            else { return "missing:\(atom.destination)@\(width)" as NSString }
            let modified = (attributes[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            let size = (attributes[.size] as? Int) ?? 0
            return "\(file.path)|\(modified)|\(size)@\(width)" as NSString
        }

        /// A decoded bitmap (and its file's pixel width) already in memory for this width.
        func cached(_ atom: TextFirstImageAtom, pixelWidth: Int) -> TextFirstCachedBitmap? {
            Self.cache.object(forKey: key(atom, pixelWidth))
        }

        /// `done` runs on the main queue with the bitmap and its file's pixel width, or nil.
        func load(
            _ atom: TextFirstImageAtom, pixelWidth: Int,
            done: @escaping @Sendable (UIImage?, Int) -> Void
        ) {
            let destination = atom.destination
            let cacheKey = key(atom, pixelWidth)
            if let hit = Self.cache.object(forKey: cacheKey) {
                DispatchQueue.main.async { done(hit.image, hit.natural) }
                return
            }
            let finish: @Sendable (UIImage?, Int) -> Void = { image, natural in
                // A file that was missing when the key was made has no identity to key it by.
                if let image, !cacheKey.hasPrefix("missing:") {
                    Self.cache.setObject(
                        TextFirstCachedBitmap(image, natural: natural), forKey: cacheKey,
                        cost: Self.cost(image))
                }
                DispatchQueue.main.async { done(image, natural) }
            }
            if atom.vault {
                guard let file = resolve(destination) else { return finish(nil, 0) }
                queue.addOperation { [weak self] in
                    guard self?.cancelled == false else { return }
                    let (image, natural) =
                        self?.decode(CGImageSourceCreateWithURL(file as CFURL, nil), pixelWidth)
                        ?? (nil, 0)
                    finish(image, natural)
                }
            } else if atom.remote, let url = URL(string: destination) {
                session.dataTask(with: url) { [weak self] data, response, _ in
                    guard let self, !self.cancelled else { return }
                    guard let data,
                        (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) })
                            ?? true
                    else { return finish(nil, 0) }
                    self.queue.addOperation {
                        let (image, natural) = self.decode(
                            CGImageSourceCreateWithData(data as CFData, nil), pixelWidth)
                        finish(image, natural)
                    }
                }.resume()
            } else {
                finish(nil, 0)
            }
        }

        /// The vault file a reference names, or nil when it leaves the vault or is not an image
        /// the shared rules serve. The reference is percent-decoded as the web editor's base URL does.
        func resolve(_ destination: String) -> URL? {
            let decoded = destination.removingPercentEncoding ?? destination
            guard !decoded.hasPrefix("/"), VaultImages.mimeType(for: decoded) != nil else {
                return nil
            }
            let file = root.appendingPathComponent(decoded).standardizedFileURL
                .resolvingSymlinksInPath()
            return file.path.hasPrefix(root.path + "/") ? file : nil
        }

        private static func cost(_ image: UIImage) -> Int {
            Int(image.size.width * image.size.height * image.scale * image.scale * 4)
        }

        /// Decode, turned upright (EXIF orientation), no wider than `pixelWidth` unless the file is.
        func decode(_ source: CGImageSource?, _ pixelWidth: Int) -> (UIImage?, Int) {
            guard let source, CGImageSourceGetCount(source) > 0,
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
                    as? [CFString: Any],
                let w = properties[kCGImagePropertyPixelWidth] as? Int,
                let h = properties[kCGImagePropertyPixelHeight] as? Int, w > 0, h > 0
            else { return (nil, 0) }
            let turned = [5, 6, 7, 8].contains(
                (properties[kCGImagePropertyOrientation] as? Int) ?? 1)
            let displayWidth = turned ? h : w
            let longest = max(w, h)
            let target =
                displayWidth > pixelWidth ? max(1, longest * pixelWidth / displayWidth) : longest
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: target,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
            else { return (nil, 0) }
            return (UIImage(cgImage: cg, scale: scale, orientation: .up), displayWidth)
        }
    }
#endif
