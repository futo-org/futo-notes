import Foundation

#if canImport(UIKit)
    import UIKit
#endif

/// Time the OS grants past `.background` for finishing work that has begun.
///
/// A seam rather than `UIApplication.shared` inline so the lifecycle path can be
/// unit-tested with a recording double, and so a non-UIKit build still links.
struct BackgroundTaskProvider {
    /// Ask for time; the closure runs if the OS takes it back first. Returns an
    /// opaque handle for `end`.
    var begin: @MainActor (_ name: String, _ onExpiry: @escaping @MainActor () -> Void) -> Int
    var end: @MainActor (_ handle: Int) -> Void

    static let system = BackgroundTaskProvider(
        begin: { name, onExpiry in
            #if canImport(UIKit)
                var handle = UIBackgroundTaskIdentifier.invalid
                handle = UIApplication.shared.beginBackgroundTask(withName: name) {
                    Task { @MainActor in
                        onExpiry()
                    }
                }
                return handle.rawValue
            #else
                return 0
            #endif
        },
        end: { handle in
            #if canImport(UIKit)
                UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: handle))
            #endif
        }
    )
}

/// Owns background time while each open note waits for its mailbox, then writes.
@MainActor
final class BackgroundEditorFlush {
    private var waiters: [UInt64: @MainActor () async -> Void] = [:]
    private let background: BackgroundTaskProvider
    private var pending: Task<Void, Never>?
    private var runId: UUID?
    nonisolated init(background: BackgroundTaskProvider = .system) { self.background = background }
    func register(token: UInt64, wait: @escaping @MainActor () async -> Void) {
        waiters[token] = wait
    }
    func release(token: UInt64) { waiters.removeValue(forKey: token) }
    func removeAll() {
        pending?.cancel()
        pending = nil
        runId = nil
        waiters.removeAll()
    }
    func run(flush: @escaping @MainActor () async -> Void) {
        guard pending == nil else { return }
        let waits = Array(waiters.values)
        let id = UUID()
        runId = id
        let lease = EditorBackgroundLease(background)
        lease.handle = background.begin("editor-flush") { [weak self] in
            lease.end()
            if self?.runId == id { self?.pending?.cancel() }
        }
        pending = Task { @MainActor in
            defer {
                lease.end()
                if runId == id {
                    pending = nil
                    runId = nil
                }
            }
            for wait in waits {
                guard !Task.isCancelled else { break }
                await wait()
            }
            await flush()
        }
    }
}

@MainActor
private final class EditorBackgroundLease {
    private let provider: BackgroundTaskProvider
    var handle: Int?
    init(_ provider: BackgroundTaskProvider) { self.provider = provider }
    func end() {
        guard let value = handle else { return }
        handle = nil
        provider.end(value)
    }
}
