import StoreKitTest
import Testing

/// Opens StoreKit's local test environment once and nothing more: the warm-up
/// process a freshly erased simulator needs before the StoreKit suites can find
/// a product (see `StoreKitTestEnvironment`). CI runs it alone, ahead of the real run.
@MainActor
@Suite("StoreKit test environment")
struct StoreKitPrimeTests {
    @Test("a session opens on this simulator")
    func sessionOpens() throws {
        let session = try SKTestSession(configurationFileNamed: "FutoNotes")
        session.resetToDefaultState()
    }
}
