# Background Sync Plan

Goal: Notes are fresh when you open the app, and sync finishes even if you leave mid-sync.

## Phase 1: Finish sync on app exit

The high-value, low-effort win. Our sync is a single HTTP round-trip — fits easily within iOS's ~30-second background window.

**Approach**: Small native Capacitor plugin wrapping platform APIs.

- **iOS**: `beginBackgroundTaskWithExpirationHandler` (~30 sec)
- **Android**: No special API needed — background work continues for several minutes

**Implementation**:

1. Create a local Capacitor plugin (no need to publish) with two methods:
   - `beginBackgroundTask()` — iOS: calls `beginBackgroundTaskWithExpirationHandler`. Android: no-op (returns immediately).
   - `endBackgroundTask()` — iOS: calls `endBackgroundTask`. Android: no-op.

2. Wire into `autoSync.ts` via the existing `@capacitor/app` listener:

```typescript
App.addListener('appStateChange', async ({ isActive }) => {
  if (!isActive) {
    await BackgroundSync.beginBackgroundTask();
    try {
      await flushPendingSave();
      await syncNow();
    } finally {
      await BackgroundSync.endBackgroundTask();
    }
  }
});
```

3. Native iOS code (`BackgroundSyncPlugin.swift`):

```swift
@objc(BackgroundSyncPlugin)
public class BackgroundSyncPlugin: CAPPlugin {
    private var backgroundTaskID: UIBackgroundTaskIdentifier = .invalid

    @objc func beginBackgroundTask(_ call: CAPPluginCall) {
        backgroundTaskID = UIApplication.shared.beginBackgroundTask(withName: "FinishSync") {
            self.endTask()
        }
        call.resolve()
    }

    @objc func endBackgroundTask(_ call: CAPPluginCall) {
        endTask()
        call.resolve()
    }

    private func endTask() {
        guard backgroundTaskID != .invalid else { return }
        UIApplication.shared.endBackgroundTask(backgroundTaskID)
        backgroundTaskID = .invalid
    }
}
```

No Info.plist changes needed — `beginBackgroundTask` doesn't require `UIBackgroundModes`.

## Phase 2: Periodic background sync (optional, lower priority)

The existing resume-sync (2-second delay on open) already covers most of the value. Periodic background sync adds marginal benefit with significant complexity.

### Options, ranked

**Option A: Silent push notifications (best if we pursue this)**

Server sends a silent push via APNs/FCM when another device syncs. This is server-initiated, battery-friendly, and more reliable than polling.

- Requires APNs + FCM integration on the server
- Requires push notification entitlements on the client
- Only wakes the app when there's actually something to sync

**Option B: `@transistorsoft/capacitor-background-fetch`**

Third-party plugin. Callback runs in WebView context so `syncNow()` works directly.

- `minimumFetchInterval: 15` (minutes, but iOS decides actual timing)
- `stopOnTerminate: false` + `startOnBoot: true` on Android
- iOS: unreliable timing — can be hours between fetches

**Option C: `@capacitor/background-runner` (official)**

Runs a separate JS file with limited APIs (`fetch`, `CapacitorKV`, no filesystem access).

- Can't call `syncNow()` directly — no access to Capacitor Filesystem
- Only practical for lightweight "check for changes" + show notification
- Would need a server `/sync/status` endpoint

### iOS reality check

| Mechanism | Time | Reliability |
|-----------|------|-------------|
| `beginBackgroundTask` (Phase 1) | ~30s | High |
| `BGAppRefreshTask` (periodic) | ~30s | Low — OS decides when |
| Silent push | ~30s | Medium — needs APNs |

Apple: "If you expect background refresh every 15 minutes, you will be disappointed." iOS learns usage patterns and may schedule refreshes hours apart. Low Power Mode disables background refresh entirely.

Android is better — WorkManager is mostly reliable, but manufacturer battery optimizations (Samsung, Xiaomi, etc.) can still kill tasks. See dontkillmyapp.com.

## Recommendation

- **Do Phase 1 now.** It's straightforward and solves the "left the app mid-sync" problem reliably.
- **Skip Phase 2 unless users complain** about the 2-second sync delay on open. If we pursue it later, silent push notifications are the right path — they're event-driven rather than polling, so they're both more reliable and more battery-friendly.
