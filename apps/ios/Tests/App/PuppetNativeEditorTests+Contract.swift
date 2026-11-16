#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    /// The native-editor contract (#431): the unsupported refusal, receipts, selection
    /// direction, stale and split positions, side-effect-free reads, and the convenience
    /// verbs that stand for taps. In the same serialized suite as the adapter's other tests.
    extension PuppetNativeEditorTests {

        func attached(_ h: TextFirstHarness) -> PuppetNativeEditor {
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            return adapter
        }

        @Test func typeAndPressAreUnsupportedOnIOSWhileAnUnknownVerbIsNot() async throws {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(
                "puppet-\(UUID().uuidString)")
            defer { try? FileManager.default.removeItem(at: root) }
            let server = PuppetServer(
                navigation: AppNavigation(), store: NotesStore(notesRoot: root),
                sync: SyncManager(), port: 1)
            for verb in ["Type", "Press", "MoveBlock", "Code", "FocusEditor"] {
                let reply = await server.perform(.verb(verb), body: Data("{}".utf8))
                #expect(reply.status == 501)
                let body = try object(reply)
                #expect(body["unsupported"] as? Bool == true)
                #expect(body["platform"] as? String == "ios")
            }
            let typed = try object(await server.perform(.verb("Type"), body: Data("{}".utf8)))
            #expect((typed["error"] as? String)?.contains("type '{") == true)
            #expect(await server.perform(.verb("Frobnicate"), body: Data("{}".utf8)).status == 404)
            let h = TextFirstHarness("plain")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            let names = adapter.actions(h.controller).compactMap { $0["name"] as? String }
            #expect(!names.contains("Type") && !names.contains("Press"))
            #expect(names.contains("ToggleTask") && names.contains("OpenLink"))
        }

        @Test func aReceiptSaysTheVersionsTheSelectionAndWhetherTheNoteChanged() async throws {
            let h = TextFirstHarness("alpha beta")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            let inserted = try object(
                await adapter.perform("Insert", arguments: ["after": "alpha", "text": "!"]))
            let versions = try #require(inserted["docVersion"] as? [String: UInt64])
            #expect(versions["before"] != versions["after"])
            #expect(inserted["changed"] as? Bool == true)
            #expect(h.source == "alpha! beta")
            let selection = try #require(inserted["selection"] as? [String: Any])
            #expect(selection["from"] as? Int == 6 && selection["to"] as? Int == 6)
            let selected = try object(await adapter.perform("Select", arguments: ["find": "beta"]))
            #expect(selected["changed"] as? Bool == false)
            #expect((selected["selection"] as? [String: Any])?["direction"] as? String == "forward")
        }

        @Test func aSelectionsDirectionIsKnownOnlyWhenPuppetMadeIt() async throws {
            let h = TextFirstHarness("alpha beta gamma")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            func direction() -> String? {
                (adapter.state(note: "note")["selection"] as? [String: Any])?["direction"]
                    as? String
            }
            h.select(0, 5)
            #expect(direction() == "unknown")
            _ = await adapter.perform("Select", arguments: ["from": 6, "to": 10])
            #expect(direction() == "forward")
            h.select(11, 16)
            #expect(direction() == "unknown")
            // Moved away and back to the same range: puppet no longer knows how.
            _ = await adapter.perform("Select", arguments: ["from": 0, "to": 5])
            _ = await adapter.perform("PlaceCaret", arguments: ["at": 0])
            h.select(0, 5)
            #expect(direction() == "unknown")
            h.select(3, 3)
            #expect(direction() == nil)
            let backward = await adapter.perform("Select", arguments: ["from": 10, "to": 6])
            #expect(backward.status == 400)
            #expect(h.tv.selectedRange == NSRange(location: 3, length: 0))
        }

        @Test func aStaleVersionOrASplitCharacterIsRefusedBeforeAnyChange() async throws {
            let h = TextFirstHarness("a 😀 b")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            let stale = PuppetNativeEditor.version(h.controller)
            _ = await adapter.perform("Insert", arguments: ["at": 0, "text": "Z"])
            let before = h.source
            let refused = await adapter.perform(
                "Replace", arguments: ["from": 0, "to": 1, "text": "Q", "docVersion": stale])
            #expect(refused.status == 409)
            #expect(try object(refused)["retryable"] == nil)
            #expect(h.source == before)
            // "Za 😀 b": the emoji is units 3 and 4.
            #expect(await adapter.perform("PlaceCaret", arguments: ["at": 4]).status == 400)
            #expect(
                await adapter.perform("Replace", arguments: ["from": 2, "to": 4, "text": "x"])
                    .status == 400)
            #expect(h.source == before)
            #expect(adapter.reply("at", arguments: ["x": 1e100, "y": 0.0]).status == 409)
        }

        @Test func aCharacterSeenAsOneIsNeverSplit() async throws {
            // "á" is a + U+0301 (units 0–1); 👍🏽 is a thumb and a skin tone (units 3–6).
            let h = TextFirstHarness("a\u{301} 👍🏽 b")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            for at in [1, 5] {
                #expect(await adapter.perform("PlaceCaret", arguments: ["at": at]).status == 400)
                #expect(
                    await adapter.perform("Insert", arguments: ["at": at, "text": "x"]).status
                        == 400)
            }
            #expect(h.source == "a\u{301} 👍🏽 b")
            #expect(await adapter.perform("PlaceCaret", arguments: ["at": 2]).status == 200)
            #expect(await adapter.perform("PlaceCaret", arguments: ["at": 7]).status == 200)
        }

        @Test func readsChangeNothingTheNextStepDependsOn() async throws {
            let h = TextFirstHarness("alpha beta")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            _ = await adapter.perform("Insert", arguments: ["after": "beta", "text": " gamma"])
            h.select(0, 5)
            let disk = try String(
                contentsOf: h.root.appendingPathComponent("note.md"), encoding: .utf8)
            let source = h.source
            let revision = h.controller.rev
            let unsaved = adapter.unsavedId
            let point = try #require(
                (try adapter.query("show", arguments: ["text": "beta"])["rect"]) as? [String: Int])
            for (query, arguments) in [
                ("state", [:]), ("doc", [:]), ("doc", ["line": 1]), ("observe", [:]),
                ("actions", [:]), ("elements", [:]), ("show", ["text": "alpha"]),
                ("at", ["x": Double(point["x"]! + 2), "y": Double(point["y"]! + 2)]),
            ] as [(String, [String: Any])] {
                _ = try adapter.query(query, arguments: arguments)
                _ = adapter.controls()
                #expect(h.source == source, "\(query) changed the source")
                #expect(h.controller.rev == revision, "\(query) moved the revision")
                #expect(h.tv.selectedRange == NSRange(location: 0, length: 5), "\(query)")
                #expect(adapter.unsavedId == unsaved, "\(query) touched the pending save")
            }
            #expect(
                try String(contentsOf: h.root.appendingPathComponent("note.md"), encoding: .utf8)
                    == disk)
            h.controller.undo()
            #expect(h.source == "alpha beta")
        }

        @Test func toggleTaskLandsWhereTheCheckboxTapDoes() async throws {
            let h = TextFirstHarness("intro\n- [ ] alpha\n- [x] beta")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            h.select(1, 1)
            let checkboxes = adapter.controls().filter { $0["role"] as? String == "checkbox" }
            #expect(checkboxes.count == 2)
            #expect(checkboxes.last?["flags"] as? [String] == ["checked"])
            let box = try #require(checkboxes.first)
            let at = try adapter.query(
                "at",
                arguments: [
                    "x": Double((box["x"] as! Int) + (box["w"] as! Int) / 2),
                    "y": Double((box["y"] as! Int) + (box["h"] as! Int) / 2),
                ])
            #expect((at["control"] as? [String: Any])?["kind"] as? String == "checkbox")
            #expect((at["control"] as? [String: Any])?["line"] as? Int == 2)
            let toggled = await adapter.perform("ToggleTask", arguments: ["find": "alpha"])
            #expect(toggled.status == 200)
            #expect(h.source == "intro\n- [x] alpha\n- [x] beta")
            #expect(h.tv.selectedRange == NSRange(location: 1, length: 0))
            #expect(await adapter.perform("ToggleTask", arguments: ["line": 3]).status == 200)
            #expect(h.source == "intro\n- [x] alpha\n- [ ] beta")
            #expect(await adapter.perform("ToggleTask", arguments: ["line": 1]).status == 409)
            h.controller.undo()
            #expect(h.source == "intro\n- [x] alpha\n- [x] beta")
        }

        @Test func openLinkAndAcceptSuggestionAreTheTapsPaths() async throws {
            let h = TextFirstHarness("see [[Other]] and [[Missing]] end")
            _ = try h.store.createNote(title: "Other", folder: "", content: "other body")
            h.controller.refreshNoteIds()
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            var opened: [String] = []
            h.controller.onOpenNote = { opened.append($0) }
            let links = adapter.controls().filter { $0["role"] as? String == "link" }
            #expect(links.map { $0["id"] as? String } == ["editor-link:note:Other"])
            #expect(await adapter.perform("OpenLink", arguments: ["find": "Other"]).status == 200)
            #expect(opened == ["Other"])
            #expect(await adapter.perform("OpenLink", arguments: ["find": "end"]).status == 409)
            _ = await adapter.perform("PlaceCaret", arguments: ["at": 0])
            #expect(
                await adapter.perform("AcceptSuggestion", arguments: ["index": 0]).status == 409)
            h.type("[[Oth")
            let names = adapter.actions(h.controller).compactMap { $0["name"] as? String }
            #expect(names.contains("AcceptSuggestion"))
            #expect(
                await adapter.perform("AcceptSuggestion", arguments: ["text": "Other"]).status
                    == 200)
            #expect(h.source.hasPrefix("[[Other]]"))
        }

        @Test func aCommandStillLandingIsNeverAnsweredAsRetryable() async throws {
            // Past `heavySelection`: Bold over all of it runs on the engine's queue.
            let h = TextFirstHarness(String(repeating: "word ", count: 12_000))
            let unmount = mount(h)
            defer { unmount() }
            let adapter = attached(h)
            #expect(await adapter.perform("SelectAll", arguments: [:]).status == 200)
            let reply = await adapter.perform("Bold", arguments: [:], settle: 0)
            #expect(reply.status == 500)
            let body = try object(reply)
            #expect(body["retryable"] as? Bool == false)
            #expect(body["pending"] as? Bool == true)
            #expect(body["docVersion"] != nil)
            // It lands on its own: a retry would have toggled it back off.
            let deadline = Date().addingTimeInterval(30)
            while h.controller.commandRunning && Date() < deadline {
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            #expect(!h.controller.commandRunning)
            #expect(h.source.hasPrefix("**word"))
        }
    }
#endif
