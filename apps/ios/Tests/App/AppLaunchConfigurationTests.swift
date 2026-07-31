import Foundation
import Testing

@testable import FutoNotesNative

@Suite("App launch configuration")
struct AppLaunchConfigurationTests {
    @Test("normal launches use the configured default roots and restore sync")
    func normalLaunch() {
        let documents = URL(fileURLWithPath: "/documents", isDirectory: true)
        let support = URL(fileURLWithPath: "/support", isDirectory: true)
        let environment: [String: String] = [:]

        #expect(AppLaunchConfiguration.resolve(environment: environment).restoresSyncSession)
        #expect(
            AppLaunchConfiguration.resolveNotesRoot(
                environment: environment,
                documentsDirectory: documents,
                defaultDirectoryName: "fake-notes"
            ).path == "/documents/fake-notes"
        )
        #expect(
            AppLaunchConfiguration.resolveSearchIndex(
                environment: environment,
                applicationSupportDirectory: support
            ).path == "/support/search"
        )
        #expect(
            AppLaunchConfiguration.keychainService(
                defaultService: "com.futo.notes.dev.sync",
                environment: environment
            ) == "com.futo.notes.dev.sync"
        )
    }

    @Test("UI tests isolate vault, search, and credentials and never restore sync")
    func uiTestLaunch() {
        let documents = URL(fileURLWithPath: "/documents", isDirectory: true)
        let support = URL(fileURLWithPath: "/support", isDirectory: true)
        let environment = [
            AppLaunchConfiguration.dataDirectoryKey: "ui-tests/run-42",
            AppLaunchConfiguration.uiTestRunIDKey: "run-42",
        ]

        #expect(!AppLaunchConfiguration.resolve(environment: environment).restoresSyncSession)
        #expect(
            AppLaunchConfiguration.resolveNotesRoot(
                environment: environment,
                documentsDirectory: documents,
                defaultDirectoryName: "fake-notes"
            ).path == "/documents/ui-tests/run-42"
        )
        #expect(
            AppLaunchConfiguration.resolveSearchIndex(
                environment: environment,
                applicationSupportDirectory: support
            ).path == "/support/ui-tests/run-42/search"
        )
        #expect(
            AppLaunchConfiguration.keychainService(
                defaultService: "com.futo.notes.dev.sync",
                environment: environment
            ) == "com.futo.notes.dev.sync.ui-tests.run-42"
        )
    }

    @Test("an absolute data override remains absolute")
    func absoluteDataOverride() {
        let root = AppLaunchConfiguration.resolveNotesRoot(
            environment: [AppLaunchConfiguration.dataDirectoryKey: "/tmp/futo-notes-test"],
            documentsDirectory: URL(fileURLWithPath: "/documents", isDirectory: true),
            defaultDirectoryName: "fake-notes"
        )

        #expect(root.path == "/tmp/futo-notes-test")
    }
}
