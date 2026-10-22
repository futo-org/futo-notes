import Foundation
import Testing

@testable import FutoNotesNative

/// Live sync never starts while the app is in the background (live-sync.md).
///
/// A connect runs its first cycle before it goes live, so the app can be
/// backgrounded in between: `pauseLive` stops live sync first, and the
/// `startLive` that follows must not reopen the stream in the background —
/// Rust saw the stop first and cannot know the start was meant to stay
/// stopped. `startLive` is where every path converges (`afterConnect` and
/// `resumeLiveAsync`); a start that goes ahead adopts a live listener first.
@Suite("Live sync and the app lifecycle")
@MainActor
struct SyncManagerLiveLifecycleTests {
    private let root = NSTemporaryDirectory() + "sync-manager-live-lifecycle-tests"

    /// A session as `afterConnect` leaves it just before going live. The
    /// client reaches no server: these check only whether a start is made.
    private func aConnectedManager() -> SyncManager {
        let manager = SyncManager()
        manager.client = SyncClient(notesRoot: root, serverUrl: "http://127.0.0.1:1")
        manager.connected = true
        return manager
    }

    @Test("a live start that lands after the app went to the background does nothing")
    func noLiveStartInTheBackground() async {
        let manager = aConnectedManager()

        manager.pauseLive()
        await manager.startLive()

        #expect(manager.liveListener == nil, "live sync started in the background")
    }

    @Test("back in the foreground, live sync starts again")
    func liveStartsAgainInTheForeground() async {
        let manager = aConnectedManager()
        manager.pauseLive()

        manager.resumeLiveAsync()
        await manager.startLive()

        #expect(manager.liveListener != nil)
    }
}
