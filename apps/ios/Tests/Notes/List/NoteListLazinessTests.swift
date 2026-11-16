#if DEBUG
    import Foundation
    import SwiftUI
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct NoteListLazinessTests {
        @Test func openingALargeFolderBuildsOnlyNearbyRows() async throws {
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(
                "note-list-laziness-\(UUID().uuidString)")
            let root = scratch.appendingPathComponent("notes")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: scratch) }
            for index in 0..<2_000 {
                try "A short note.\n".write(
                    to: root.appendingPathComponent("large-list-\(index).md"),
                    atomically: false, encoding: .utf8)
            }
            let store = NotesStore(
                notesRoot: root, searchIndex: scratch.appendingPathComponent("index"))
            let deadline = ContinuousClock.now.advanced(by: .seconds(15))
            while !store.hasBootstrapped && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(store.hasBootstrapped)
            #expect(store.notes.count == 2_000)

            var built = Set<String>()
            NoteRow.didInitializeForTesting = { id in
                if id.hasPrefix("large-list-") { built.insert(id) }
            }
            defer { NoteRow.didInitializeForTesting = nil }
            let start = ContinuousClock.now
            let host = UIHostingController(
                rootView: NavigationStack {
                    FolderContentsView(folder: "", navPath: .constant([]))
                }
                .environmentObject(store)
                .environmentObject(AppNavigation()))
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 402, height: 874))
            window.rootViewController = host
            window.isHidden = false
            defer {
                window.isHidden = true
                window.rootViewController = nil
            }
            host.view.frame = window.bounds
            host.view.layoutIfNeeded()
            print(
                "LIST_BUILD_BENCH notes=2000 built=\(built.count) duration=\(start.duration(to: .now))"
            )
            // A screen holds fewer than twenty rows. Allow generous prefetching, but
            // never construct the entire collection just to discover scroll identities.
            #expect(!built.isEmpty)
            #expect(built.count < 100)
        }
    }
#endif
