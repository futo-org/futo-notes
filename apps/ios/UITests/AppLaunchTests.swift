import XCTest

final class AppLaunchTests: XCTestCase {
    @MainActor
    func testShellRendersWithoutWaitingForVaultBootstrap() {
        let app = makeIsolatedApplication()
        app.launch()

        XCTAssertTrue(app.navigationBars["Notes"].waitForExistence(timeout: 5))
    }
}
