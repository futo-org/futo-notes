import Foundation
import Testing

@testable import FutoNotesNative

@MainActor
struct CertificateFailureMessageTests {
    @Test func rustlsChainFailureNamesTheCertificate() {
        let manager = SyncManager()
        let error = SyncError.Http("error sending request: invalid peer certificate: UnknownIssuer")

        #expect(
            manager.failureMessage(error, fallback: "sync.errors.connectFailed").path
                == "sync.errors.certificateNotTrusted")
    }

    @Test func platformVerifierRejectionAlsoNamesTheCertificate() {
        let manager = SyncManager()
        let rejection = "Other(OtherError(\"private ca certificate is not trusted: -67843\"))"
        let error = SyncError.Http("error sending request: invalid peer certificate: \(rejection)")

        #expect(
            manager.failureMessage(error, fallback: "sync.errors.connectFailed").path
                == "sync.errors.certificateNotTrusted")
    }

    @Test func anUnrelatedFailureKeepsTheFallback() {
        let manager = SyncManager()
        let error = SyncError.Http("connection refused")

        #expect(
            manager.failureMessage(error, fallback: "sync.errors.connectFailed").path
                == "sync.errors.connectFailed")
    }

    // The live loop reports through `setLastError`, not `failureMessage`: the
    // Rust runner prefixes an event-stream connect failure with `connect:`, and
    // a background cycle's failure arrives with no prefix at all.
    @Test func liveLoopConnectRejectionNamesTheCertificate() {
        let manager = SyncManager()
        manager.setLastError(
            "connect: error sending request for url (https://notes.example.com/api/sync/events): "
                + "client error (Connect): invalid peer certificate: UnknownIssuer")

        #expect(manager.lastErrorMessage?.path == "sync.errors.certificateNotTrusted")
    }

    @Test func liveLoopCycleRejectionNamesTheCertificate() {
        let manager = SyncManager()
        manager.setLastError(
            "error sending request for url (https://notes.example.com/api/sync/changes): "
                + "client error (Connect): invalid peer certificate: UnknownIssuer")

        #expect(manager.lastErrorMessage?.path == "sync.errors.certificateNotTrusted")
    }

    @Test func liveLoopConnectFailureStaysOnTheMutedLiveLine() {
        let manager = SyncManager()
        manager.setLastError("connect: error sending request: connection refused")

        #expect(manager.liveErrorMessage?.path == "sync.errors.liveUnavailable")
        #expect(manager.lastErrorMessage == nil)
    }
}
