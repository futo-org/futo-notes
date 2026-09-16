import CoreImage
import CoreImage.CIFilterBuiltins
import UIKit

/// Turns a pairing payload into a picture a camera can read.
///
/// One of the two things Rust cannot do for pairing (ADR 0003, decision 11):
/// the engine hands over a payload string and this draws it. Nothing here reads
/// the payload's shape — a QR code is bytes in, black-and-white squares out —
/// so a change to what the payload carries never reaches this file.
///
/// Error correction is `M`, matching the desktop renderer: a screen is not a
/// printed label, but a phone camera reads it at an angle, off a display with
/// its own glare and scaling, so the cheapest level is not the right one.
///
/// The generator emits one pixel per module, which a view would smooth into
/// mush, so it is scaled up here and drawn with `.interpolation(.none)`.
func pairingCodeImage(payload: String, scale: CGFloat = 12) -> UIImage? {
    let generator = CIFilter.qrCodeGenerator()
    generator.message = Data(payload.utf8)
    generator.correctionLevel = "M"
    guard let modules = generator.outputImage else { return nil }
    let enlarged = modules.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let rendered = CIContext().createCGImage(enlarged, from: enlarged.extent) else {
        return nil
    }
    return UIImage(cgImage: rendered)
}
