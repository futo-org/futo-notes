import Foundation
import Testing

@testable import FutoNotesNative

@Suite("CrashlogEndpoint")
struct CrashlogEndpointTests {
    @Test("the debug toggle moves crash and feedback uploads to staging")
    func stagingToggle() {
        let defaults = UserDefaults.standard
        let previous = defaults.bool(forKey: CrashlogEndpoint.stagingKey)
        defer { defaults.set(previous, forKey: CrashlogEndpoint.stagingKey) }

        defaults.set(false, forKey: CrashlogEndpoint.stagingKey)
        #expect(CrashlogEndpoint.baseUrl == "http://localhost:5100")

        defaults.set(true, forKey: CrashlogEndpoint.stagingKey)
        #expect(CrashlogEndpoint.baseUrl == "https://staging-notes-crashlog.futo.org")
        #expect(
            CrashlogEndpoint.url("/api/feedback").absoluteString
                == "https://staging-notes-crashlog.futo.org/api/feedback")
    }
}
