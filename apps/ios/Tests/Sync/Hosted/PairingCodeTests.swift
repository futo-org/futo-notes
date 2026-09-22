import AVFoundation
import Foundation
import Testing

@testable import FutoNotesNative

/// The two halves of pairing a shell owns on iOS: drawing a payload as a QR
/// code, and reading the clock the relay set. Neither decides anything about a
/// pairing — Rust does — so each is tested for exactly what it renders.
@Suite("Pairing code rendering")
struct PairingCodeTests {
    /// A real payload: versioned JSON carrying the pairing id, the one-time
    /// public key, and the new device's name and platform.
    private let payload = """
        {"futo_notes_pairing":1,"id":"01J8Z3X4Y5","pk":"kPvWQ2h9aZ0m8Nn3o4L5s6T7u8V9w0X1y2Z3a4B5c6D=",\
        "name":"New iPad","platform":"ios"}
        """

    @Test("a payload becomes a picture, scaled up so a camera has modules to read")
    func aPayloadDraws() {
        let drawn = pairingCodeImage(payload: payload)
        #expect(drawn != nil)
        guard let drawn else { return }
        // CoreImage emits one pixel per module; unscaled that is a picture ~30
        // pixels across, which no camera would resolve off a phone screen.
        #expect(drawn.size.width >= 200)
        #expect(drawn.size.width == drawn.size.height)
    }

    @Test("the scale multiplies the module grid rather than cropping it")
    func scaleMultiplies() {
        guard let small = pairingCodeImage(payload: payload, scale: 1),
            let large = pairingCodeImage(payload: payload, scale: 10)
        else {
            Issue.record("both scales should draw")
            return
        }
        #expect(large.size.width == small.size.width * 10)
    }
}

@Suite("Pairing countdown")
struct PairingCountdownTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("whole seconds until the relay's own deadline")
    func secondsUntil() {
        #expect(
            pairingSecondsRemaining(until: "2027-01-15T12:00:00Z", now: expiry(minus: 90)) == 90)
        #expect(
            pairingSecondsRemaining(until: "2027-01-15T12:00:00.500Z", now: expiry(minus: 10)) == 11
        )
    }

    /// The safe way to be wrong: a code that is shown as spent, never one that
    /// is promised time it may not have.
    @Test("a deadline that has passed, or that cannot be read, is no time at all")
    func nothingLeft() {
        #expect(
            pairingSecondsRemaining(until: "2027-01-15T12:00:00Z", now: expiry(minus: -30)) == 0)
        #expect(pairingSecondsRemaining(until: "not a timestamp", now: now) == 0)
        #expect(pairingSecondsRemaining(until: "", now: now) == 0)
    }

    @Test("m:ss is the shape a countdown is read in")
    func theShapeOnScreen() {
        #expect(formatPairingCountdown(300) == "5:00")
        #expect(formatPairingCountdown(61) == "1:01")
        #expect(formatPairingCountdown(9) == "0:09")
        #expect(formatPairingCountdown(0) == "0:00")
        #expect(formatPairingCountdown(-5) == "0:00")
    }

    /// 2027-01-15T12:00:00Z, moved by `minus` seconds.
    private func expiry(minus seconds: TimeInterval) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: "2027-01-15T12:00:00Z")!.addingTimeInterval(-seconds)
    }
}

@Suite("Pairing camera access")
struct PairingCameraAccessTests {
    @Test("a camera this app may use is the only thing that opens the scanner")
    func onlyAuthorizedScans() {
        #expect(pairingCameraAccess(.authorized, hasCamera: true) == .ready)
        #expect(pairingCameraAccess(.notDetermined, hasCamera: true) == .ask)
    }

    /// A device under parental or MDM control cannot be talked into a camera
    /// either, so it gets the same answer as a refusal: the message and the
    /// vault-password door on the other device.
    @Test("refused and restricted are one answer")
    func refusedAndRestrictedAreOneAnswer() {
        #expect(pairingCameraAccess(.denied, hasCamera: true) == .denied)
        #expect(pairingCameraAccess(.restricted, hasCamera: true) == .denied)
    }

    /// The simulator's everyday case, and the reason the scan path is driven by
    /// an injected string rather than by hardware.
    @Test("no camera at all is its own answer, whatever the permission says")
    func noCameraIsNotARefusal() {
        for status: AVAuthorizationStatus in [.authorized, .notDetermined, .denied, .restricted] {
            #expect(pairingCameraAccess(status, hasCamera: false) == .noCamera)
        }
    }
}
