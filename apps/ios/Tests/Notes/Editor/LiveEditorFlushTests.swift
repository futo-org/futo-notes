import Testing

@testable import FutoNotesNative

/// The leave-active flush reads the live editor first, holds the change-fed
/// flush while it does, and runs inside a background task (RC-92). The reading
/// itself is `EditorSession.refreshFromLiveEditor` (EditorSessionTests); this is
/// the ordering around it.
@Suite("Live editor flush")
@MainActor
struct LiveEditorFlushTests {
    @MainActor
    final class Log {
        var events: [String] = []
        func append(_ event: String) { events.append(event) }
    }

    private func provider(_ log: Log) -> BackgroundTaskProvider {
        BackgroundTaskProvider(
            begin: { name, _ in
                log.append("bg-begin:\(name)")
                return 7
            },
            end: { handle in log.append("bg-end:\(handle)") }
        )
    }

    @Test("every editor is read, then the register is flushed, all inside one background task")
    func readsThenFlushesInsideABackgroundTask() async {
        let log = Log()
        let flush = LiveEditorFlush(background: provider(log))
        flush.register(token: 1) { log.append("read") }

        let task = flush.run { log.append("flush") }
        // The background task is requested synchronously, before anything suspends.
        #expect(log.events == ["bg-begin:flush editor"])
        await task?.value

        #expect(log.events == ["bg-begin:flush editor", "read", "flush", "bg-end:7"])
    }

    @Test("the change-fed flush is held while a read is out")
    func holdsTheOlderDraftWhileReading() async {
        let log = Log()
        let flush = LiveEditorFlush(background: provider(log))
        let answer = EditorSessionTests.Signal()
        var heldDuringRead = false
        flush.register(token: 1) {
            heldDuringRead = flush.isHolding
            await answer.wait()
        }

        let task = flush.run { log.append("flush") }
        await Task.yield()
        #expect(flush.isHolding)
        #expect(!log.events.contains("flush"))

        answer.set()
        await task?.value
        #expect(heldDuringRead)
        #expect(!flush.isHolding)
        #expect(log.events.contains("flush"))
    }

    @Test(".background after .inactive neither reads again nor flushes ahead of the read")
    func oneReadPerEpisode() async {
        let log = Log()
        let flush = LiveEditorFlush(background: provider(log))
        let answer = EditorSessionTests.Signal()
        var reads = 0
        flush.register(token: 1) {
            reads += 1
            await answer.wait()
        }

        let inactive = flush.run { log.append("flush") }
        await Task.yield()
        // The second signal arrives while the first read is out: handled, not repeated.
        let background = flush.run { log.append("flush-again") }
        #expect(background != nil)
        answer.set()
        await inactive?.value
        await background?.value

        // A third, after the episode's read finished: the caller flushes the register as it stands.
        #expect(flush.run { log.append("flush-again") } == nil)
        #expect(reads == 1)
        #expect(log.events.filter { $0.hasPrefix("flush") } == ["flush"])

        flush.rearm()
        let next = flush.run { log.append("flush") }
        await next?.value
        #expect(reads == 2)
    }

    @Test("with no editor to read the caller flushes the register as it stands")
    func noEditorIsThePlainFlush() {
        let log = Log()
        let flush = LiveEditorFlush(background: provider(log))
        #expect(flush.run { log.append("flush") } == nil)
        #expect(log.events.isEmpty)

        flush.register(token: 1) {}
        flush.release(token: 1)
        #expect(flush.run { log.append("flush") } == nil)
        flush.register(token: 2) {}
        flush.removeAll()
        #expect(flush.run { log.append("flush") } == nil)
    }

    @Test("a read that never returns is abandoned: the register flushes as it stands")
    func aStuckReadIsAbandoned() async {
        let log = Log()
        let flush = LiveEditorFlush(background: provider(log), budgetNanoseconds: 50_000_000)
        let never = EditorSessionTests.Signal()
        flush.register(token: 1) { await never.wait() }

        _ = flush.run { log.append("flush") }
        try? await Task.sleep(nanoseconds: 300_000_000)

        #expect(!flush.isHolding)
        #expect(log.events.contains("flush"))
        #expect(log.events.contains("bg-end:7"))
        never.set()
    }
}
