import Foundation
import Testing

@testable import FutoNotesNative

/// `VaultImages.mimeType(for:)` is the serve-time allow-list for the
/// `futo-asset://` scheme handler: a nil result means the file is refused.
@Suite("VaultImages.mimeType")
struct VaultImagesMimeTypeTests {
  @Test(
    "rejects non-image and extensionless filenames",
    arguments: ["note.md", "archive.txt", "script.js", "noextension", "trailingdot."])
  func rejectsNonImages(_ filename: String) {
    #expect(VaultImages.mimeType(for: filename) == nil)
  }

  @Test("maps known image extensions to their content type")
  func mapsKnownExtensions() {
    let expected: [String: String] = [
      "photo.png": "image/png",
      "photo.jpg": "image/jpeg",
      "photo.jpeg": "image/jpeg",
      "anim.gif": "image/gif",
      "pic.webp": "image/webp",
      "icon.svg": "image/svg+xml",
    ]
    for (filename, mime) in expected {
      #expect(VaultImages.mimeType(for: filename) == mime, "\(filename)")
    }
  }

  @Test("extension match is case-insensitive")
  func matchIsCaseInsensitive() {
    #expect(VaultImages.mimeType(for: "PHOTO.PNG") == "image/png")
    #expect(VaultImages.mimeType(for: "Photo.JpG") == "image/jpeg")
  }

  /// Drift lock against the shared Rust image list: `mimeType` guards on
  /// `imageExtensions()` (UniFFI) and then switches, so any extension Rust adds
  /// without a matching `case` here falls through to `nil` — and the scheme
  /// handler would refuse to serve a supposedly-allowed image. This fails until
  /// `VaultImages.mimeType` gains the case.
  @Test("every shared image extension has a MIME mapping")
  func coversSharedImageExtensions() {
    let shared = imageExtensions()
    #expect(!shared.isEmpty)
    for ext in shared {
      #expect(
        VaultImages.mimeType(for: "x.\(ext)") != nil,
        "no MIME mapping for shared image extension .\(ext)")
    }
  }
}
