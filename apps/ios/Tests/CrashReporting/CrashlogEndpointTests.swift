import Foundation
import Testing

@testable import FutoNotesNative

@Suite("CrashlogEndpoint")
struct CrashlogEndpointTests {
    @Test("the debug toggle moves crash and feedback uploads to staging")
    func stagingToggle() throws {
        let defaults = UserDefaults.standard
        let previous = defaults.bool(forKey: CrashlogEndpoint.stagingKey)
        defer { defaults.set(previous, forKey: CrashlogEndpoint.stagingKey) }

        defaults.set(false, forKey: CrashlogEndpoint.stagingKey)
        let configUrl = try #require(
            Bundle.main.url(forResource: "futo-dev-ports", withExtension: "json"))
        let config = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: configUrl)) as? [String: Int])
        let port = try #require(config["crashlogPort"])
        #expect((5100...5149).contains(port))
        #expect(CrashlogEndpoint.baseUrl == "http://localhost:\(port)")

        defaults.set(true, forKey: CrashlogEndpoint.stagingKey)
        #expect(CrashlogEndpoint.baseUrl == "https://staging-notes-crashlog.futo.org")
        #expect(
            CrashlogEndpoint.url("/api/feedback").absoluteString
                == "https://staging-notes-crashlog.futo.org/api/feedback")
    }
}
