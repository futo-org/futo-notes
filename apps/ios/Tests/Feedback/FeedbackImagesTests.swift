import Foundation
import Testing
import UIKit

@testable import FutoNotesNative

@Suite("FeedbackImages")
struct FeedbackImagesTests {
    private func jpeg(width: Int, height: Int) -> Data {
        let size = CGSize(width: width, height: height)
        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }
        return image.jpegData(compressionQuality: 1.0)!
    }

    @Test("passes through the formats the server accepts")
    func acceptsServerFormats() {
        for ext in ["png", "jpg", "jpeg", "webp", "PNG", "JPEG"] {
            #expect(FeedbackImages.needsTranscode(ext: ext, byteCount: 1024) == false)
        }
    }

    @Test("transcodes what the dashboard cannot render")
    func transcodesUnsupportedFormats() {
        for ext in ["heic", "gif", "avif", "bmp", "tiff"] {
            #expect(FeedbackImages.needsTranscode(ext: ext, byteCount: 1024))
        }
    }

    @Test("transcodes an accepted format that is over the cap, but not one at it")
    func transcodesOnSize() {
        #expect(FeedbackImages.needsTranscode(ext: "png", byteCount: FeedbackImages.maxBytes + 1))
        #expect(FeedbackImages.needsTranscode(ext: "png", byteCount: FeedbackImages.maxBytes) == false)
    }

    @Test("returns the original bytes untouched when no transcode is needed")
    func keepsOriginalBytes() {
        let original = jpeg(width: 24, height: 24)
        let picked = PickedImage(data: original, ext: "jpeg")

        #expect(FeedbackImages.normalize(picked) == original)
    }

    @Test("re-encodes an unsupported format to something the server accepts")
    func reencodesUnsupportedFormat() throws {
        let picked = PickedImage(data: jpeg(width: 24, height: 24), ext: "heic")
        let normalized = try #require(FeedbackImages.normalize(picked))

        #expect(Array(normalized.prefix(3)) == [0xFF, 0xD8, 0xFF])
    }

    @Test("gives up rather than sending bytes the server will reject")
    func rejectsUndecodableBytes() {
        let picked = PickedImage(data: Data([0x00, 0x01, 0x02]), ext: "heic")

        #expect(FeedbackImages.normalize(picked) == nil)
    }
}

@Suite("DeviceInfo")
struct DeviceInfoTests {
    @Test("reports the hardware identifier, not the generic model name")
    func reportsHardwareIdentifier() {
        let model = DeviceInfo.hardwareModel()

        #expect(!model.isEmpty)
        #expect(model != "iPhone")
        #expect(model != UIDevice.current.model)
    }
}
