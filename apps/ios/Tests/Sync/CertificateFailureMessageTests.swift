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
}
