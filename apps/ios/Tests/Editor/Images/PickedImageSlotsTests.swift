import Foundation
import Testing

@testable import FutoNotesNative

@Suite("PickedImageSlots")
struct PickedImageSlotsTests {
    private func image(_ marker: UInt8, _ ext: String = "png") -> PickedImage {
        PickedImage(data: Data([marker]), ext: ext)
    }

    @Test("returns images in slot order even when they arrive backwards")
    func preservesOrderAcrossOutOfOrderCompletions() {
        let slots = PickedImageSlots(count: 3)
        slots.put(image(3), at: 2)
        slots.put(image(1), at: 0)
        slots.put(image(2), at: 1)

        #expect(slots.ordered().map { $0.data.first } == [1, 2, 3])
    }

    @Test("drops slots whose provider yielded nothing, without shifting the rest")
    func compactsFailedLoads() {
        let slots = PickedImageSlots(count: 3)
        slots.put(image(1), at: 0)
        slots.put(nil, at: 1)
        slots.put(image(3), at: 2)

        #expect(slots.ordered().map { $0.data.first } == [1, 3])
    }

    @Test("yields nothing when every provider failed")
    func allFailed() {
        let slots = PickedImageSlots(count: 2)
        slots.put(nil, at: 0)
        slots.put(nil, at: 1)

        #expect(slots.ordered().isEmpty)
    }

    @Test("keeps each slot's extension with its own bytes")
    func keepsPerImageExtension() {
        let slots = PickedImageSlots(count: 2)
        slots.put(image(1, "heic"), at: 0)
        slots.put(image(2, "webp"), at: 1)

        #expect(slots.ordered().map { $0.ext } == ["heic", "webp"])
    }

    @Test("is safe to fill from many queues at once")
    func concurrentWrites() {
        let slots = PickedImageSlots(count: 64)
        DispatchQueue.concurrentPerform(iterations: 64) { index in
            slots.put(image(UInt8(index)), at: index)
        }

        #expect(slots.ordered().map { Int($0.data.first!) } == Array(0..<64))
    }
}
