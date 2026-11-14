#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite("native editor puppet adapter", .serialized) @MainActor
    struct PuppetNativeEditorTests {
        private func mount(_ h: TextFirstHarness) -> () -> Void {
            let previous = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows).first(where: \.isKeyWindow)
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                h.window.windowScene = scene
            }
            h.window.makeKeyAndVisible()
            h.tv.layoutIfNeeded()
            return {
                h.tv.resignFirstResponder()
                h.window.isHidden = true
                previous?.makeKey()
            }
        }
        private func object(_ reply: PuppetReply) throws -> [String: Any] {
            try #require(JSONSerialization.jsonObject(with: reply.body) as? [String: Any])
        }

        @Test func openingAndRetiredControllersNeverReportAReadyWebView() {
            let adapter = PuppetNativeEditor()
            #expect(adapter.state(note: "opening")["surface"] as? String == "native")
            #expect(adapter.state(note: "opening")["ready"] as? Bool == false)
            let first = TextFirstHarness("first", id: "one")
            let second = TextFirstHarness("second", id: "two")
            defer {
                first.window.isHidden = true
                second.window.isHidden = true
            }
            adapter.attach(first.controller, title: { "one" })
            adapter.attach(second.controller, title: { "two" })
            adapter.clear(first.controller)
            #expect(adapter.controller === second.controller)
            #expect(adapter.state(note: "different")["ready"] as? Bool == false)
            adapter.clear(second.controller)
            #expect(adapter.controller == nil)
        }

        @Test func unicodeSelectionTypingAndTraceUseNativeDisplayOffsets() async throws {
            let h = TextFirstHarness("a 😀 tail")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            let doc = try adapter.query("doc", arguments: [:])
            #expect((doc["lines"] as? [[String: Any]])?.first?["at"] as? Int == 0)
            let selected = await adapter.perform("Select", arguments: ["find": "😀"])
            #expect(selected.status == 200)
            #expect(h.controller.effectiveSelection == NSRange(location: 2, length: 2))
            _ = try adapter.query("trace", arguments: ["begin": true])
            let typed = await adapter.perform("Type", arguments: ["text": "Q"])
            #expect(typed.status == 200)
            #expect(h.source == "a Q tail")
            let trace = try adapter.query("trace", arguments: ["end": true])
            #expect(trace["events"] as? [Int] == [0, 0])
            #expect((trace["diff"] as? [String: Any])?["doc"] != nil)
            #expect((trace["diff"] as? [String: Any])?["selection"] != nil)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func selectionReceiptsUseCurrentHeadingParagraphAndInlineFormats() async throws {
            let h = TextFirstHarness("# heading\nplain **bold** text")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            for (needle, expected) in [
                ("heading", "heading-1"), ("plain", "paragraph"), ("bold", "bold"),
            ] {
                let reply = await adapter.perform("Select", arguments: ["find": needle])
                #expect(reply.status == 200)
                let body = try object(reply)
                let editor = try #require(body["editor"] as? [String: Any])
                let selection = try #require(editor["selection"] as? [String: Any])
                let formats = try #require(selection["formats"] as? [String])
                let canonical = try h.controller.session.toolbarHighlights().active.sorted()
                #expect(formats == canonical)
                #expect(formats.contains(expected))
            }
        }

        @Test func blankRowsKeepTheirActualDisplayCaretOffsets() throws {
            for source in ["", "alpha\n", "\n", "alpha\n\n", "alpha\n\nomega\n", "🧠\n", "注\n\n"] {
                let h = TextFirstHarness(source)
                let unmount = mount(h)
                defer { unmount() }
                let document = PuppetNativeEditor.Document(h.controller)
                for original in document.shown where original.range.length == 0 {
                    let row = document.row(original)
                    #expect(row["at"] as? Int == original.range.location)
                    #expect(row["end"] as? Int == original.range.location)
                    #expect(row["text"] as? String == "")
                }
            }
        }

        @Test func readingDuringMarkedTextDoesNotCommitOrSaveIt() throws {
            let h = TextFirstHarness("base")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            h.select(4, 4)
            h.tv.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
            let before = try h.controller.session.sourceText()
            let revision = h.controller.rev
            let selection = h.tv.selectedRange
            _ = try adapter.query("doc", arguments: [:])
            _ = adapter.state(note: "note")
            #expect(h.tv.markedTextRange != nil)
            #expect(try h.controller.session.composition() != nil)
            #expect(try h.controller.session.sourceText() == before)
            #expect(h.controller.rev == revision)
            #expect(h.tv.selectedRange == selection)
            #expect(
                try String(contentsOf: h.root.appendingPathComponent("note.md"), encoding: .utf8)
                    == "base")
        }

        @Test func staleAndHiddenRangesAreRefusedBeforeAnEdit() async throws {
            let h = TextFirstHarness((0..<300).map { "row \($0)" }.joined(separator: "\n"))
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            let stale = PuppetNativeEditor.version(h.controller)
            let hidden = adapter.reply("doc", arguments: ["line": 290])
            #expect(hidden.status == 409)
            let typed = await adapter.perform("Type", arguments: ["text": "Q"])
            #expect(typed.status == 200)
            let before = h.source
            let rejected = await adapter.perform(
                "PlaceCaret", arguments: ["at": 0, "docVersion": stale])
            #expect(rejected.status == 409)
            #expect(h.source == before)
            let split = await adapter.perform("PlaceCaret", arguments: ["at": -1])
            #expect(split.status == 400)
        }

        @Test func insertIsOneLiteralTransactionAndTypeRunsEnter() async throws {
            let inserted = TextFirstHarness("- item")
            let unmount = mount(inserted)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(inserted.controller, title: { "note" })
            let result = await adapter.perform("Insert", arguments: ["at": 4, "text": "\nnext"])
            #expect(result.status == 200)
            #expect(inserted.source == "- item\nnext")
            inserted.controller.undo()
            #expect(inserted.source == "- item")
            _ = await adapter.perform("PlaceCaret", arguments: ["at": 4])
            _ = await adapter.perform("Type", arguments: ["text": "\nnext"])
            #expect(inserted.source == "- item\n- next")
        }

        @Test func clipboardCommandsKeepTheirOwnBuffer() async throws {
            let h = TextFirstHarness("alpha beta")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            UIPasteboard.general.string = "OS sentinel"
            _ = await adapter.perform("Select", arguments: ["find": "alpha"])
            let copied = await adapter.perform("Copy", arguments: [:])
            #expect(copied.status == 200)
            #expect(adapter.clipboard == "alpha")
            #expect(UIPasteboard.general.string == "OS sentinel")
            _ = await adapter.perform("PlaceCaret", arguments: ["at": 10])
            _ = await adapter.perform("Paste", arguments: [:])
            #expect(h.source == "alpha betaalpha")
            #expect(UIPasteboard.general.string == "OS sentinel")
        }

        @Test func documentVersionsStartWithAProcessNonceWithinSafeJsonIntegers() {
            let h = TextFirstHarness("nonce")
            defer { h.window.isHidden = true }
            let version = PuppetNativeEditor.version(h.controller)
            #expect(version >= 1 << 32)
            #expect(version < 1 << 53)
        }

        @Test func selectAllCanCopyCutPasteAndReplaceBeyondTheViewport() async throws {
            let source = String(repeating: "wrapped word ", count: 200)
            let h = TextFirstHarness(source)
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            #expect((await adapter.perform("Press", arguments: ["key": "Mod-a"])).status == 200)
            #expect((await adapter.perform("Copy", arguments: [:])).status == 200)
            #expect(adapter.clipboard == source)
            #expect((await adapter.perform("Cut", arguments: [:])).status == 200)
            #expect(h.source.isEmpty)
            #expect((await adapter.perform("Paste", arguments: [:])).status == 200)
            #expect(h.source == source)
            // A keyboard shortcut can still run with an existing offscreen selection.
            h.select(0, (h.tv.text as NSString).length)
            #expect((await adapter.perform("Press", arguments: ["key": "Mod-a"])).status == 200)
            #expect(
                (await adapter.perform("Type", arguments: ["text": "replacement"])).status == 200)
            #expect(h.source == "replacement")
        }

        @Test func aPartlyVisibleWrappedLineDoesNotExposeItsHiddenSourceHunk() async throws {
            let h = TextFirstHarness("")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            let before = adapter.snapshot()
            let source = String(repeating: "wrapped word ", count: 200) + "PRIVATE-TAIL"
            let response = await adapter.perform("Insert", arguments: ["at": 0, "text": source])
            #expect(response.status == 200)
            let after = adapter.snapshot()
            let doc = try #require(adapter.diff(before, after)["doc"] as? [String: Any])
            #expect(doc["offscreen"] as? Bool == true)
            #expect(doc["partial"] as? Bool == true)
            #expect(doc["inserted"] == nil)
            #expect(doc["removed"] == nil)
            let encoded = String(
                decoding: try JSONSerialization.data(withJSONObject: doc), as: UTF8.self)
            #expect(!encoded.contains("PRIVATE-TAIL"))
        }

        @Test func anEditedLineDoesNotDeleteAnUnchangedLineThatScrolledAway() throws {
            let adapter = PuppetNativeEditor()
            let before = PuppetNativeEditor.Snapshot(
                id: 1,
                rows: [
                    ["line": 1, "kind": "paragraph", "text": "alpha"],
                    ["line": 2, "kind": "paragraph", "text": "beta"],
                ], selection: nil, revision: 1, title: "note", source: "alpha\nbeta",
                fullyVisibleLines: [1, 2])
            let after = PuppetNativeEditor.Snapshot(
                id: 2,
                rows: [
                    ["line": 2, "kind": "paragraph", "text": "betaX"]
                ], selection: nil, revision: 2, title: "note", source: "alpha\nbetaX",
                fullyVisibleLines: [2])
            let doc = try #require(adapter.diff(before, after)["doc"] as? [String: Any])
            #expect(doc["line"] as? Int == 2)
            #expect(doc["removed"] as? String == "")
            #expect(doc["inserted"] as? String == "X")
        }

        @Test func immediateReceiptsKeepAllVisibleLinesAfterTypingAndSelection() async throws {
            let h = TextFirstHarness("")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            _ = await adapter.perform("Type", arguments: ["text": "alpha beta\ngamma delta"])
            let state = adapter.state(note: "note")
            #expect((state["onScreen"] as? [String: Int]) == ["first": 1, "last": 2])
            let selected = try object(await adapter.perform("Select", arguments: ["find": "beta"]))
            let editor = try #require(selected["editor"] as? [String: Any])
            #expect((editor["selection"] as? [String: Any])?["text"] as? String == "beta")
        }

        @Test func wrappedParagraphDoesNotExposeOrSelectItsHiddenTail() async throws {
            let h = TextFirstHarness(
                String(repeating: "visible word ", count: 1500) + "HIDDEN-TAIL")
            let unmount = mount(h)
            defer { unmount() }
            let adapter = PuppetNativeEditor()
            adapter.attach(h.controller, title: { "note" })
            let doc = try adapter.query("doc", arguments: [:])
            let json = String(
                decoding: try JSONSerialization.data(withJSONObject: doc), as: UTF8.self)
            #expect(!json.contains("HIDDEN-TAIL"))
            #expect(adapter.reply("show", arguments: ["text": "HIDDEN-TAIL"]).status == 409)
            let end = (h.tv.text as NSString).length
            let rejected = await adapter.perform(
                "Select", arguments: ["from": end - 11, "to": end])
            #expect(rejected.status == 409)
            let spansHidden = await adapter.perform("Select", arguments: ["from": 0, "to": end])
            #expect(spansHidden.status == 409)
        }

        @Test func documentVersionCannotBeReusedForAnotherController() async throws {
            let first = TextFirstHarness("first", id: "first")
            let unmountFirst = mount(first)
            defer { unmountFirst() }
            let adapter = PuppetNativeEditor()
            adapter.attach(first.controller, title: { "first" })
            let version = try #require(
                try adapter.query("doc", arguments: [:])["docVersion"] as? UInt64)
            let second = TextFirstHarness("second", id: "second")
            let unmountSecond = mount(second)
            defer { unmountSecond() }
            adapter.attach(second.controller, title: { "second" })
            let rejected = await adapter.perform(
                "PlaceCaret", arguments: ["at": 0, "docVersion": version])
            #expect(rejected.status == 409)
        }

        @Test func fileSaveFalseIsPureAndSaveTrueCheckpointsNativeEdits() async throws {
            let rig = try await TextFirstVaultRig(body: "base")
            defer { rig.tearDown() }
            if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene {
                rig.window.windowScene = scene
            }
            let previousKey = UIApplication.shared.connectedScenes.compactMap {
                $0 as? UIWindowScene
            }.flatMap(\.windows).first(where: \.isKeyWindow)
            rig.window.makeKeyAndVisible()
            defer {
                rig.controller.textView.resignFirstResponder()
                rig.window.isHidden = true
                previousKey?.makeKey()
            }
            defer { PuppetNativeEditor.shared.clear(rig.controller) }
            PuppetNativeEditor.shared.attach(rig.controller, title: { "note" })
            rig.selectEnd()
            rig.type(" tail")
            let navigation = AppNavigation()
            navigation.path = [.note("note")]
            let server = PuppetServer(
                navigation: navigation, store: rig.store, sync: SyncManager(), port: 1)
            let before = try object(
                await server.file(body: Data(#"{"noteId":"note","save":false}"#.utf8)))
            #expect(before["text"] as? String == "base")
            let state = try object(await server.state())
            #expect((state["pending"] as? [String: Any])?["unsaved"] as? [String] == ["note"])
            let saved = try object(
                await server.file(body: Data(#"{"noteId":"note","save":true}"#.utf8)))
            #expect(saved["text"] as? String == "base tail")
            #expect(rig.disk("note") == "base tail")
            _ = await rig.controller.close()
        }

    }
#endif
