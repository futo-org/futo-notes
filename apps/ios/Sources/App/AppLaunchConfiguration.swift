import Foundation

struct AppLaunchConfiguration {
    static let dataDirectoryKey = "FUTO_NOTES_DATA_DIR"
    static let uiTestRunIDKey = "FUTO_NOTES_UI_TEST_RUN_ID"

    let restoresSyncSession: Bool

    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppLaunchConfiguration {
        AppLaunchConfiguration(
            restoresSyncSession: normalizedUITestRunID(in: environment) == nil
        )
    }

    static func resolveNotesRoot(
        environment: [String: String],
        documentsDirectory: URL,
        defaultDirectoryName: String
    ) -> URL {
        guard
            let override = environment[dataDirectoryKey]?.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            !override.isEmpty
        else {
            return documentsDirectory.appendingPathComponent(
                defaultDirectoryName,
                isDirectory: true
            )
        }

        if override.hasPrefix("/") {
            return URL(fileURLWithPath: override, isDirectory: true)
        }
        return documentsDirectory.appendingPathComponent(override, isDirectory: true)
    }

    static func resolveSearchIndex(
        environment: [String: String],
        applicationSupportDirectory: URL
    ) -> URL {
        guard let runID = normalizedUITestRunID(in: environment) else {
            return applicationSupportDirectory.appendingPathComponent("search", isDirectory: true)
        }
        return
            applicationSupportDirectory
            .appendingPathComponent("ui-tests", isDirectory: true)
            .appendingPathComponent(runID, isDirectory: true)
            .appendingPathComponent("search", isDirectory: true)
    }

    static func keychainService(
        defaultService: String,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        guard let runID = normalizedUITestRunID(in: environment) else {
            return defaultService
        }
        return "\(defaultService).ui-tests.\(runID)"
    }

    private static func normalizedUITestRunID(in environment: [String: String]) -> String? {
        guard
            let runID = environment[uiTestRunIDKey]?.trimmingCharacters(
                in: .whitespacesAndNewlines
            ),
            !runID.isEmpty
        else {
            return nil
        }
        return runID
    }
}
