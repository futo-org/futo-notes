import XCTest

@MainActor
func makeIsolatedApplication() -> XCUIApplication {
    let app = XCUIApplication()
    let runID = UUID().uuidString
    app.launchEnvironment[AppLaunchEnvironment.dataDirectory] = "ui-tests/\(runID)"
    app.launchEnvironment[AppLaunchEnvironment.runID] = runID
    return app
}

/// The editor's SYSTEM back button, which UIKit identifies as "BackButton" (its label is
/// the previous screen's title, so never query by label).
///
/// Queried app-wide rather than under `navigationBars`: on the iOS 27.1 iPhone Duo layout
/// the bar's items move into a trailing-edge rail that the accessibility tree exposes as a
/// `Toolbar`, and the editor screen has no `NavigationBar` element at all (issue #271).
@MainActor
func systemBackButton(in app: XCUIApplication) -> XCUIElement {
    app.buttons["BackButton"]
}

private enum AppLaunchEnvironment {
    static let dataDirectory = "FUTO_NOTES_DATA_DIR"
    static let runID = "FUTO_NOTES_UI_TEST_RUN_ID"
}
