import AVFoundation
import SwiftUI
import UIKit

/// Whether this device can read a pairing code right now.
///
/// `restricted` is folded into `denied` on purpose: a device under parental or
/// MDM control cannot be talked into a camera either, so the person needs the
/// same answer — the vault-password door on the other device.
enum PairingCameraAccess {
    case ready
    case ask
    case denied
    /// No camera hardware at all. A simulator is the everyday case.
    case noCamera
}

func pairingCameraAccess(_ status: AVAuthorizationStatus, hasCamera: Bool) -> PairingCameraAccess {
    if !hasCamera { return .noCamera }
    switch status {
    case .authorized: return .ready
    case .notDetermined: return .ask
    case .denied, .restricted: return .denied
    @unknown default: return .denied
    }
}

/// What this device can do about a camera, asked of AVFoundation.
func currentPairingCameraAccess() -> PairingCameraAccess {
    pairingCameraAccess(
        AVCaptureDevice.authorizationStatus(for: .video),
        hasCamera: AVCaptureDevice.default(for: .video) != nil)
}

/// The camera, and nothing else. It reads QR codes and hands up the string
/// inside one — every decision about that string is made above it, which is
/// what lets the whole scan path be exercised without a camera (ADR 0003,
/// decision 12).
struct PairingScannerView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PairingScannerPreview {
        let preview = PairingScannerPreview()
        context.coordinator.start(showing: preview)
        return preview
    }

    func updateUIView(_ preview: PairingScannerPreview, context: Context) {}

    static func dismantleUIView(_ preview: PairingScannerPreview, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let session = AVCaptureSession()
        /// `startRunning` blocks until the camera is up, so it never runs on the
        /// main thread.
        private let cameraQueue = DispatchQueue(label: "com.futo.notes.pairing-scanner")
        private let onCode: (String) -> Void
        /// A camera in front of one code reports it many times a second.
        /// Reporting only a change means an unreadable code raises its message
        /// once instead of on every frame.
        private var lastReported: String?

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func start(showing preview: PairingScannerPreview) {
            guard let camera = AVCaptureDevice.default(for: .video),
                let input = try? AVCaptureDeviceInput(device: camera),
                session.canAddInput(input)
            else { return }
            session.addInput(input)

            let codes = AVCaptureMetadataOutput()
            guard session.canAddOutput(codes) else { return }
            session.addOutput(codes)
            codes.setMetadataObjectsDelegate(self, queue: .main)
            codes.metadataObjectTypes = [.qr]

            preview.previewLayer.session = session
            preview.previewLayer.videoGravity = .resizeAspectFill
            cameraQueue.async { [session] in session.startRunning() }
        }

        func stop() {
            cameraQueue.async { [session] in session.stopRunning() }
        }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput metadataObjects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            let scanned =
                metadataObjects
                .compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
                .first
            guard let scanned, scanned != lastReported else { return }
            lastReported = scanned
            // The delegate queue above is the main queue.
            MainActor.assumeIsolated { onCode(scanned) }
        }
    }
}

/// A view whose backing layer IS the camera preview, so the picture resizes
/// with the view instead of being kept in step by hand.
final class PairingScannerPreview: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }

    var previewLayer: AVCaptureVideoPreviewLayer {
        // Guaranteed by `layerClass`.
        layer as! AVCaptureVideoPreviewLayer
    }
}
