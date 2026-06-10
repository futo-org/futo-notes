import SwiftUI

@main
struct FutoNotesApp: App {
    @StateObject private var store = NotesStore()
    @StateObject private var sync = SyncManager()
    @ObservedObject private var crash = CrashReporter.shared
    @Environment(\.scenePhase) private var scenePhase

    /// "light" | "dark" | "auto" — set from Settings (futo.themeMode), applied
    /// app-wide here. The editor WebView follows automatically: NoteEditorView
    /// derives its pushed theme from @Environment(\.colorScheme), which
    /// preferredColorScheme overrides.
    @AppStorage("futo.themeMode") private var themeMode = "auto"

    init() {
        // Install the crash hooks before ANY other work — a crash during app
        // init must still be captured for the next launch.
        CrashReporter.install()
    }

    var body: some Scene {
        WindowGroup {
            NoteListView()
                .environmentObject(store)
                .environmentObject(sync)
                .tint(Theme.primary)
                .preferredColorScheme(
                    themeMode == "light" ? .light : themeMode == "dark" ? .dark : nil)
                // Crash Report sheet for reports found by the launch scan (only
                // when reporting is enabled and Always-send is off).
                .sheet(isPresented: Binding(
                    get: { !crash.pendingReports.isEmpty },
                    set: { if !$0 { crash.pendingReports = [] } }
                )) {
                    CrashReportSheet(reporter: crash)
                }
                // Refresh the note list when a live pull brings in remote
                // changes (sync + note store are separate objects), then
                // cold-launch auto-reconnect from the stored password so live
                // sync resumes after a force-quit without re-entering it.
                .task {
                    // A live pull rewrote the vault: reload the list AND rescan
                    // the search index (remote edits bypass the per-mutation
                    // notify* calls).
                    sync.onLivePull = { store.liveDataChanged() }
                    // Auto-push local edits: every NotesStore mutation signals
                    // the live loop, which debounces and pushes to peers (no-op
                    // when not connected). Mirrors Android's MainActivity wiring.
                    store.onLocalChange = { sync.noteChanged() }
                    // Pre-warm the shared editor WebView once at app start so the
                    // first note-open doesn't pay the WebKit-boot + bundle-parse
                    // cost on the navigation critical path (F11). Mirrors
                    // Android's EditorHost.prewarm in MainActivity.
                    EditorHost.prewarm()
                    // Crash logs from the previous run — before restoreSession so
                    // a slow/offline server can't delay the crash dialog.
                    await crash.processPendingReports()
                    await sync.restoreSession(notesRoot: store.notesRoot.path)
                }
        }
        // Pause the SSE stream while backgrounded and re-open it on foreground —
        // a fresh `ready` then drives a catch-up pull. Mirrors Android's
        // onStart/onStop.
        .onChange(of: scenePhase) { _, newPhase in
            switch newPhase {
            case .active:
                sync.resumeLiveAsync()
            case .inactive:
                // Flush the open editor's pending edit at the FIRST leave-active
                // signal — an edit caught inside the 400 ms autosave debounce
                // would otherwise be lost to jetsam (F8). `.inactive` precedes
                // `.background`, so flushing here gives the write the most time to
                // land. Idempotent: a no-op when the draft is clean. Live sync is
                // left alone (a brief inactive — banner / control center — must
                // not tear down the SSE stream).
                store.flushPendingEditor()
            case .background:
                // Belt-and-suspenders flush (a phase can jump straight to
                // background), then pause the SSE stream.
                store.flushPendingEditor()
                sync.pauseLive()
            @unknown default:
                break
            }
        }
    }
}
