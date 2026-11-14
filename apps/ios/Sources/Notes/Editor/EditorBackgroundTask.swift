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

@MainActor
final class EditorBackgroundLease {
    private let provider: BackgroundTaskProvider
    var handle: Int?
    init(_ provider: BackgroundTaskProvider) { self.provider = provider }
    func end() {
        guard let value = handle else { return }
        handle = nil
        provider.end(value)
    }
}
