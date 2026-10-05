import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Note sort preference")
struct NoteSortPreferenceTests {
    @Test("defaults to last modified, newest first")
    func defaultsToLastModifiedNewestFirst() {
        #expect(NoteSortPreference.fallback.key == .lastModified)
        #expect(NoteSortPreference.fallback.direction == .descending)
        #expect(NoteSortPreference.resolve("") == NoteSortPreference.fallback)
    }

    @Test("round-trips through the stored raw value")
    func roundTripsThroughRawValue() {
        let order = NoteSortOrder(key: .name, direction: .descending)
        #expect(NoteSortPreference.rawValue(order) == "name:descending")
        #expect(NoteSortPreference.resolve(NoteSortPreference.rawValue(order)) == order)
    }

    @Test("falls back to the default on garbage or unknown values")
    func garbageFallsBack() {
        #expect(NoteSortPreference.resolve("created:up") == NoteSortPreference.fallback)
        #expect(NoteSortPreference.resolve("name") == NoteSortPreference.fallback)
        #expect(NoteSortPreference.resolve("name:sideways") == NoteSortPreference.fallback)
    }

    @Test("a key change keeps the menu position: Recent first pairs with A-Z")
    func keyChangeKeepsPosition() {
        let recent = NoteSortOrder(key: .lastModified, direction: .descending)
        #expect(
            NoteSortPreference.withKey(.name, keepingPositionOf: recent).direction == .ascending)
        let reversed = NoteSortOrder(key: .name, direction: .descending)
        #expect(
            NoteSortPreference.withKey(.lastModified, keepingPositionOf: reversed).direction
                == .ascending)
    }

    @Test("lists each key's natural direction first")
    func directionOrderPerKey() {
        #expect(NoteSortPreference.directions(for: .name) == [.ascending, .descending])
        #expect(NoteSortPreference.directions(for: .lastModified) == [.descending, .ascending])
    }

    @Test("labels directions by what they mean for the active key")
    func directionLabelsFollowTheKey() {
        #expect(NoteSortPreference.directionLabelPath(.name, .ascending) == "notes.sort.aToZ")
        #expect(NoteSortPreference.directionLabelPath(.name, .descending) == "notes.sort.zToA")
        #expect(
            NoteSortPreference.directionLabelPath(.lastModified, .descending)
                == "notes.sort.newest"
        )
        #expect(
            NoteSortPreference.directionLabelPath(.lastModified, .ascending) == "notes.sort.oldest"
        )
        #expect(NoteSortPreference.keyLabelPath(.name) == "notes.sort.name")
        #expect(NoteSortPreference.keyLabelPath(.lastModified) == "notes.sort.lastModified")
    }

    @Test("the storage key stays the shipped futo.noteSortOrder key")
    func storageKeyIsStable() {
        #expect(NoteSortPreference.storageKey == "futo.noteSortOrder")
    }

    @Test("stores and reads back through UserDefaults")
    func storesThroughUserDefaults() throws {
        let defaults = try #require(UserDefaults(suiteName: "futo.noteSortOrder.tests"))
        defaults.removeObject(forKey: NoteSortPreference.storageKey)
        #expect(NoteSortPreference.stored(in: defaults) == NoteSortPreference.fallback)

        let order = NoteSortOrder(key: .name, direction: .ascending)
        NoteSortPreference.store(order, in: defaults)
        #expect(NoteSortPreference.stored(in: defaults) == order)
        defaults.removeObject(forKey: NoteSortPreference.storageKey)
    }
}
