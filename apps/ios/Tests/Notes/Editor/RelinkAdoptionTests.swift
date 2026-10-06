import Testing

@testable import FutoNotesNative

@Suite @MainActor
struct RelinkAdoptionTests {
    @Test func refusedRelinkRebasesOnEachRevisionAndStopsAfterThree() async {
        var generations: [Int] = []
        var revision = 0
        var live = "[[old]]"
        var base = live
        await settleRelinkAdoption(
            flushed: live, relinkedBody: "[[new]]",
            awaitCurrent: {
                revision += 1
                return EditorCurrent(
                    latest: DocumentSnapshot(generation: revision, content: live), behind: false)
            },
            liveContent: { live }, receiveChange: { live = $0 }, setBaseline: { base = $0 },
            apply: { text, generation in
                #expect(text == "[[new]]")
                generations.append(generation)
                return false
            }
        )
        #expect(generations == [1, 2, 3])
        #expect(live == "[[old]]")
        #expect(base == "[[new]]")
    }

    @Test func editDeliveredAfterRefusalIsKeptAgainstRelinkedBaseline() async {
        var waits = 0
        var offers = 0
        var live = "[[old]]"
        var base = live
        await settleRelinkAdoption(
            flushed: live, relinkedBody: "[[new]]",
            awaitCurrent: {
                waits += 1
                return EditorCurrent(
                    latest: DocumentSnapshot(
                        generation: waits, content: waits == 1 ? live : "[[old]] typed"),
                    behind: false)
            },
            liveContent: { live }, receiveChange: { live = $0 }, setBaseline: { base = $0 },
            apply: { _, _ in
                offers += 1
                return false
            }
        )
        #expect(offers == 1)
        #expect(live == "[[old]] typed")
        #expect(base == "[[new]]")
    }
}
