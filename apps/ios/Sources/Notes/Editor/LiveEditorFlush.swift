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
                        UIApplication.shared.endBackgroundTask(handle)
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

/// The leave-active flush reads the LIVE editor first (RC-92).
///
/// The register the scenePhase flush pulls is fed by the editor's `change`
/// messages, and a note that is still streaming its tail reports none — it never
/// reports a prefix — while a typed edit spends 200 ms in the bundle's debounce.
/// The text most likely to be lost to backgrounding is exactly the text the
/// register does not have. So every visible editor registers a refresher (read
/// the live document into the draft, through the exit's bounded capture) and the
/// flush runs them first, inside a background task so the OS keeps the process
/// long enough to finish the read and the write.
///
/// While the reads are out, the change-fed flush is HELD: writing the older
/// draft now and the live one after would put two different texts over the same
/// base, and the engine would park the newer as a conflict copy.
///
/// One read per foreground/background episode: `.inactive` and `.background` both
/// call `run`, and the second finds the first's work already done or in flight.
@MainActor
final class LiveEditorFlush {
    typealias Refresh = @MainActor () async -> Void

    private var refreshers: [UInt64: Refresh] = [:]
    private var inFlight = 0
    private var refreshedThisEpisode = false
    private let background: BackgroundTaskProvider
    private let budget: UInt64

    /// `budgetNanoseconds`: three 6 s capture deadlines and the save in flight,
    /// inside the ~30 s the OS grants a background task.
    nonisolated init(
        background: BackgroundTaskProvider = .system,
        budgetNanoseconds: UInt64 = 25_000_000_000
    ) {
        self.background = background
        self.budget = budgetNanoseconds
    }

    /// True while reads are out: the change-fed flush must wait for them.
    var isHolding: Bool { inFlight > 0 }

    func register(token: UInt64, refresh: @escaping Refresh) {
        refreshers[token] = refresh
    }

    func release(token: UInt64) {
        refreshers[token] = nil
    }

    func removeAll() {
        refreshers.removeAll()
    }

    /// The next backgrounding reads afresh (scenePhase `.active`).
    func rearm() {
        refreshedThisEpisode = false
    }

    /// Read every registered editor, then `flush`, all inside one background
    /// task. Returns nil when there is nothing to read (or this episode already
    /// read): the caller flushes the register as it stands. Otherwise the task,
    /// which finishes after `flush` has (a task already running answers a second
    /// call, which need do nothing).
    ///
    /// The hold on the change-fed flush is bounded: when the OS takes the
    /// background task back, or the budget runs out, the reads are abandoned
    /// and the register flushes as it stands.
    @discardableResult
    func run(flush: @escaping @MainActor () async -> Void) -> Task<Void, Never>? {
        guard inFlight == 0 else { return Task {} }
        guard !refreshers.isEmpty, !refreshedThisEpisode else { return nil }
        refreshedThisEpisode = true
        inFlight += 1
        var held = true
        let release: @MainActor () -> Void = { [self] in
            guard held else { return }
            held = false
            inFlight -= 1
        }
        let reads = Array(refreshers.values)
        var handle = 0
        let abandon: @MainActor () -> Void = { [background] in
            guard held else { return }
            release()
            Task { @MainActor in
                await flush()
                background.end(handle)
            }
        }
        handle = background.begin("flush editor", abandon)
        let watchdog = Task { @MainActor [budget] in
            try? await Task.sleep(nanoseconds: budget)
            guard !Task.isCancelled else { return }
            abandon()
        }
        return Task { @MainActor [self] in
            for read in reads {
                guard held else { break }
                await read()
            }
            watchdog.cancel()
            release()
            await flush()
            background.end(handle)
        }
    }
}
