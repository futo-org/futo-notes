#if DEBUG
    import Foundation
    import WebKit
    import os

    /// Debug-only hook for the on-device block-drag benchmark
    /// (`scripts/perf/block-drag-bench/ios-app.mjs` + `BlockDragBenchTests`).
    ///
    /// A physical iPhone paired over the network has no usbmuxd entry, so the
    /// WebKit inspector (ios_webkit_debug_proxy) cannot reach the page. Instead
    /// the UI test passes the probe script in `FUTO_BLOCK_DRAG_BENCH_JS`, this
    /// evaluates it in the editor page once the editor is up, and the page posts
    /// its results back through the `futoBench` handler, which appends them to
    /// `Documents/futo-bench-results.jsonl` (copied off with `devicectl`).
    /// Absent the variable none of it is installed.
    final class BlockDragBenchProbe: NSObject, WKScriptMessageHandler {
        static let handlerName = "futoBench"
        private static let log = Logger(subsystem: "com.futo.notes", category: "block-drag-bench")
        private static let script: String? = {
            let raw = ProcessInfo.processInfo.environment["FUTO_BLOCK_DRAG_BENCH_JS"]
            return (raw?.isEmpty == false) ? raw : nil
        }()

        static var isEnabled: Bool { script != nil }
        private var started = false

        func startIfNeeded(in webView: WKWebView) {
            guard !started, let script = Self.script else { return }
            started = true
            if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? FileManager.default.removeItem(
                    at: dir.appendingPathComponent("futo-bench-results.jsonl"))
            }
            webView.evaluateJavaScript(script) { _, error in
                if let error { Self.log.error("probe failed to start: \(String(describing: error))") }
            }
        }

        func userContentController(
            _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
        ) {
            guard let line = message.body as? String else { return }
            Self.log.notice("bench \(line, privacy: .public)")
            guard
                let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
                    .first
            else { return }
            let url = dir.appendingPathComponent("futo-bench-results.jsonl")
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: url) {
                handle.seekToEndOfFile()
                handle.write(data)
                try? handle.close()
            } else {
                try? data.write(to: url)
            }
        }
    }
#endif
