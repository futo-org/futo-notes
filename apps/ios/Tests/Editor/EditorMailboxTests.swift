import Foundation
import Testing

@testable import FutoNotesNative

@Suite @MainActor
struct EditorMailboxTests {
    @Test func currentNeedsNoBridgeTraffic() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("a", generation: 1, content: "base")
        let answer = await mailbox.awaitCurrent("a") { _ in
            Issue.record("current mailbox must not flush")
        }
        #expect(answer.latest?.content == "base")
        #expect(answer.canProceed)
    }
    @Test func outgoingChangeNeverOverwritesIncomingNote() {
        let mailbox = EditorMailbox()
        mailbox.loaded("a", generation: 1, content: "A")
        mailbox.loaded("b", generation: 3, content: "B")
        mailbox.edited("a", generation: 2)
        mailbox.change("a", generation: 2, content: "A edited")
        #expect(mailbox.current("a").latest?.content == "A edited")
        #expect(mailbox.current("b").latest?.content == "B")
        #expect(!mailbox.change("a", generation: 1, content: "old"))
    }
    @Test func behindFlushesOnceAndAnyChangeSatisfiesIt() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("a", generation: 1, content: "base")
        mailbox.edited("a", generation: 2)
        var calls = 0
        let answer = await mailbox.awaitCurrent("a") { _ in
            calls += 1
            mailbox.change("a", generation: 3, content: "typed")
        }
        #expect(calls == 1)
        #expect(answer.canProceed)
        #expect(answer.latest?.content == "typed")
    }
    @Test func unansweredBehindRefusesThenRetrySeesDeliveredChange() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("a", generation: 1, content: "base")
        mailbox.edited("a", generation: 2)
        let first = await mailbox.awaitCurrent("a", deadline: 0.001) { _ in }
        #expect(!first.canProceed)
        mailbox.change("a", generation: 2, content: "typed")
        let retry = await mailbox.awaitCurrent("a") { _ in Issue.record("retry already current") }
        #expect(retry.canProceed)
    }
    @Test func failureRefusesButDeathProceedsOnLatest() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("a", generation: 1, content: "base")
        mailbox.edited("a", generation: 2)
        let failed = await mailbox.awaitCurrent("a") { mailbox.failed("a", token: $0) }
        #expect(!failed.canProceed)
        let dead = await mailbox.awaitCurrent("a") { _ in mailbox.rendererGone() }
        #expect(dead.canProceed)
        #expect(dead.latest?.content == "base")
        mailbox.loaded("a", generation: 1, content: "restored")
        #expect(!mailbox.current("a").rendererGone)
    }
    @Test func detachedOutgoingOwnerRetainsOneLateDraft() {
        let mailbox = EditorMailbox()
        var a: [String] = []
        var b: [String] = []
        var retained: [String] = []
        mailbox.bind(1, id: "a") { a.append($0) }
        mailbox.bind(2, id: "b") { b.append($0) }
        mailbox.loaded("a", generation: 1, content: "A")
        mailbox.loaded("b", generation: 3, content: "B")
        mailbox.edited("a", generation: 2)
        mailbox.detach(1)
        mailbox.retainUnflushed("a") { retained.append($0) }
        mailbox.change("a", generation: 2, content: "A edited")
        mailbox.change("a", generation: 2, content: "duplicate")
        #expect(a.isEmpty && b.isEmpty)
        #expect(retained == ["A edited"])
        #expect(mailbox.current("b").latest?.content == "B")
    }
    @Test func detachCannotRemoveANewerBindingForTheSameNote() {
        let mailbox = EditorMailbox()
        var reports: [String] = []
        mailbox.bind(1, id: "a") { _ in Issue.record("detached callback") }
        mailbox.bind(2, id: "a") { reports.append($0) }
        mailbox.detach(1)
        mailbox.change("a", generation: 2, content: "latest")
        #expect(reports == ["latest"])
    }
    @Test func aNewOpenCannotReuseThePlaceholderOrAnEarlierCleanSnapshot() {
        let mailbox = EditorMailbox()
        mailbox.loaded("", generation: 1, content: "")
        mailbox.loaded("a", generation: 2, content: "old body")
        mailbox.prepareLoad("a")
        #expect(!mailbox.change("a", generation: 2, content: "late blur echo"))
        #expect(mailbox.current("a").latest == nil)
        #expect(mailbox.current("a").canProceed)
        mailbox.loaded("a", generation: 3, content: "disk body")
        #expect(mailbox.current("a").latest?.content == "disk body")
        mailbox.edited("a", generation: 4)
        mailbox.prepareLoad("a")
        #expect(mailbox.current("a").behind)
        #expect(mailbox.current("a").latest?.content == "disk body")
    }

    @Test func renamedIdentityWaitsForItsOwnAcknowledgmentBeforeRelinking() async {
        let mailbox = EditorMailbox()
        mailbox.loaded("old", generation: 1, content: "back to [[old]]")
        mailbox.loaded("new", generation: 0, content: "earlier deleted note")
        mailbox.prepareLoad("new")
        var loads = 0
        let wait = Task { @MainActor in
            await mailbox.awaitLoaded("new") { loads += 1 }
        }
        await Task.yield()
        #expect(loads == 1)
        #expect(mailbox.current("new").latest == nil)
        mailbox.loaded("other", generation: 2, content: "other body")
        #expect(mailbox.current("new").latest == nil)
        mailbox.loaded("new", generation: 3, content: "back to [[old]]")
        let ready = await wait.value
        #expect(ready.latest?.generation == 3)
        #expect(ready.latest?.content == "back to [[old]]")
        _ = await mailbox.awaitLoaded("new") { Issue.record("already loaded") }
    }
    @Test func unansweredLoadDoesNotInventARevision() async {
        let mailbox = EditorMailbox()
        let answer = await mailbox.awaitLoaded("new", deadline: 0.001) {}
        #expect(answer.latest == nil)
    }

    @Test func sameIdStackDeliversOnlyToNewestView() {
        let mailbox = EditorMailbox()
        var parent: [String] = []
        var child: [String] = []
        mailbox.bind(1, id: "a") { parent.append($0) }
        mailbox.bind(2, id: "a") { child.append($0) }
        mailbox.change("a", generation: 1, content: "child edit")
        #expect(parent.isEmpty)
        #expect(child == ["child edit"])
        mailbox.detach(2)
        mailbox.change("a", generation: 2, content: "parent edit")
        #expect(parent == ["parent edit"])
    }

    @Test func pruningReleasesUnusedBodiesAndKeepsLateDraftDelivery() {
        let mailbox = EditorMailbox()
        mailbox.loaded("old", generation: 1, content: "large old body")
        mailbox.prune(keeping: "new")
        #expect(mailbox.current("old").latest == nil)
        mailbox.loaded("dirty", generation: 2, content: "base")
        mailbox.edited("dirty", generation: 3)
        var retained: [String] = []
        mailbox.retainUnflushed("dirty") { retained.append($0) }
        mailbox.prune(keeping: "new")
        mailbox.change("dirty", generation: 3, content: "late draft")
        #expect(retained == ["late draft"])
        mailbox.prune(keeping: "new")
        #expect(mailbox.current("dirty").latest == nil)
    }

}
