import AVFoundation
import SwiftUI
import UIKit

/// "Scan another device" on an already-unlocked device: the camera, one
/// confirmation naming the device that showed the code, and Send (parent spec
/// user stories 15 and 16).
///
/// A device with no camera, or one whose camera this app may not use, is not a
/// dead end: it says so and points at the door that is still open — typing the
/// vault password on the device being set up (ADR 0003, decision 5).
///
/// This is **pushed** onto the Sync sheet's navigation stack, not presented as
/// a second sheet. A `.sheet` modifier anywhere inside that `Form` is handed
/// down to every row it renders, which UIKit reports as a dozen simultaneous
/// "Attempt to present … which is already presenting" and which took the Sync
/// sheet down with it. A push is one screen, once.
struct ScanAnotherDeviceView: View {
    @ObservedObject var model: HostedSetupModel

    @Environment(\.localization) private var localization
    @State private var access: PairingCameraAccess = .ask

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let error = model.errorMessage {
                    Text(localization.localizedText(error.path, arguments: error.arguments))
                        .font(.callout)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("hosted-scan-error")
                }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding()
        }
        .navigationTitle(localization.localizedText("sync.hosted.pairing.scan.title"))
        .navigationBarTitleDisplayMode(.inline)
        // The camera runs for exactly as long as this screen is up.
        .onAppear { model.openScanner() }
        .onDisappear { model.closeScanner() }
        .task { await resolveCameraAccess() }
        .confirmationDialog(
            localization.localizedText("sync.hosted.pairing.scan.confirm.title"),
            isPresented: Binding(
                get: { model.scanPhase == .confirming },
                set: { presented in if !presented { model.cancelConfirmation() } }),
            titleVisibility: .visible
        ) {
            Button(localization.localizedText("common.actions.send")) {
                Task { await model.sendVaultKey() }
            }
            .accessibilityIdentifier("hosted-scan-send")
            Button(localization.localizedText("common.actions.cancel"), role: .cancel) {
                model.cancelConfirmation()
            }
        } message: {
            if let scanned = model.scannedPairing {
                Text(
                    localization.localizedText(
                        "sync.hosted.pairing.scan.confirm.body",
                        arguments: ["device": describe(scanned)]))
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch access {
        case .ask:
            ProgressView()
        case .noCamera:
            withoutCamera(
                title: "sync.hosted.pairing.scan.noCamera.title",
                explanation: "sync.hosted.pairing.scan.noCamera.body",
                identifier: "hosted-scan-no-camera",
                offerSettings: false)
        case .denied:
            withoutCamera(
                title: "sync.hosted.pairing.scan.permissionDenied.title",
                explanation: "sync.hosted.pairing.scan.permissionDenied.body",
                identifier: "hosted-scan-permission-denied",
                offerSettings: true)
        case .ready:
            if model.scanPhase == .sent, let scanned = model.scannedPairing {
                Text(localization.localizedText("sync.hosted.pairing.scan.sent.title"))
                    .font(.headline)
                    .accessibilityIdentifier("hosted-scan-sent")
                Text(
                    localization.localizedText(
                        "sync.hosted.pairing.scan.sent.body",
                        arguments: ["device": describe(scanned)])
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            } else {
                camera
            }
        }
    }

    @ViewBuilder
    private var camera: some View {
        Text(localization.localizedText("sync.hosted.pairing.scan.body"))
            .font(.callout)
            .foregroundStyle(.secondary)
        PairingScannerView { code in
            Task { await model.readScannedCode(code) }
        }
        .frame(height: 320)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityIdentifier("hosted-scan-camera")
        if model.scanPhase == .sending {
            HStack {
                ProgressView()
                Text(localization.localizedText("sync.hosted.pairing.scan.sending"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// No camera, or no permission to use it — and the way through anyway.
    @ViewBuilder
    private func withoutCamera(
        title: String, explanation: String, identifier: String, offerSettings: Bool
    ) -> some View {
        Text(localization.localizedText(title))
            .font(.headline)
            .accessibilityIdentifier(identifier)
        Text(localization.localizedText(explanation))
            .font(.callout)
            .foregroundStyle(.secondary)
        Text(localization.localizedText("sync.hosted.pairing.scan.fallback"))
            .font(.callout)
            .accessibilityIdentifier("hosted-scan-fallback")
        if offerSettings, let settings = URL(string: UIApplication.openSettingsURLString) {
            Button(localization.localizedText("sync.hosted.pairing.scan.openSettings")) {
                UIApplication.shared.open(settings)
            }
            .accessibilityIdentifier("hosted-scan-open-settings")
        }
    }

    /// The scanned device, as the confirmation names it: its self-reported name
    /// verbatim, and its platform in words. An unrecognised platform is shown
    /// as it came rather than as a missing catalog path.
    private func describe(_ scanned: any ScannedPairing) -> String {
        let platform =
            ["ios", "android", "desktop"].contains(scanned.platform)
            ? localization.localizedText(
                "sync.hosted.pairing.scan.confirm.platform.\(scanned.platform)")
            : scanned.platform
        return localization.localizedText(
            "sync.hosted.pairing.scan.confirm.device",
            arguments: ["name": scanned.deviceName, "platform": platform])
    }

    private func resolveCameraAccess() async {
        let current = currentPairingCameraAccess()
        guard current == .ask else {
            access = current
            return
        }
        access = await AVCaptureDevice.requestAccess(for: .video) ? .ready : .denied
    }
}
