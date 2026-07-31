import XCTest

@MainActor
func makeIsolatedApplication() -> XCUIApplication {
    let app = XCUIApplication()
    let runID = UUID().uuidString
    app.launchEnvironment[AppLaunchEnvironment.dataDirectory] = "ui-tests/\(runID)"
    app.launchEnvironment[AppLaunchEnvironment.runID] = runID
    return app
}

private enum AppLaunchEnvironment {
    static let dataDirectory = "FUTO_NOTES_DATA_DIR"
    static let runID = "FUTO_NOTES_UI_TEST_RUN_ID"
}
