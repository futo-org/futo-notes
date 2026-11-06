#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstEditorTests {
        @Test func typingEnterAndBackspaceReachTheEngine() throws {
            let h = TextFirstHarness("")
            h.type("ab")
            _ = h.tv.delegate?.textView?(h.tv, shouldChangeTextIn: h.tv.selectedRange, replacementText: "\n")
            h.type("cd")
            #expect(h.source == "ab\ncd")
            #expect(h.display == "ab\ncd")
            h.tv.deleteBackward()
            #expect(h.source == "ab\nc")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aSelectionIsReportedAndDeletedThroughTheEngine() throws {
            let h = TextFirstHarness("hello **bold** world")
            h.select(2, 8)
            #expect(h.controller.engineSelection == NSRange(location: 2, length: 6))
            h.type("X")
            #expect(h.source.hasPrefix("heXld") || h.source.contains("X"))
            #expect(h.tv.text == (try h.controller.session.displayText()))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func undoAndRedoAreTheEngines() throws {
            let h = TextFirstHarness("x")
            h.select(1, 1)
            h.type("abc")
            #expect(h.source == "xabc")
            h.tv.undoManager?.undo()
            #expect(h.source == "x")
            #expect(h.display == "x")
            h.tv.undoManager?.redo()
            #expect(h.source == "xabc")
            #expect(h.display == "xabc")
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func leavingSavesTheExactBytesAndReopeningShowsThem() async throws {
            let h = TextFirstHarness("# Title\n\n**bold** tail\r\n")
            h.select(h.display.utf16.count, h.display.utf16.count)
            h.type(" more")
            let saved = await h.controller.close()
            _ = try saved.get()
            let onDisk = try h.store.read(id: "note")
            #expect(onDisk.hasPrefix("# Title"))
            let again = try h.reopen()
            #expect(try again.controller.session.sourceText() == onDisk)
            #expect(again.display.contains("more"))
            _ = await again.controller.close()
        }

        @Test func theStoreSavesOnItsDebounceWithoutAnyHostWrite() async throws {
            let h = TextFirstHarness("start")
            h.select(5, 5)
            h.type("!")
            try await Task.sleep(nanoseconds: 3_000_000_000)
            #expect(try h.store.read(id: "note").hasPrefix("start!"))
            _ = await h.controller.close()
        }

        @Test func systemTextActionsSeeDisplayTextWhileCopyAndCutExportMarkdown() throws {
            let h = TextFirstHarness("**bold** and `code` x")
            h.select(0, 4)
            // Look Up, Translate, Share and the keyboard read the view's own text: no markers.
            #expect(h.tv.text(in: h.tv.selectedTextRange!) == "bold")
            UIPasteboard.general.string = ""
            h.tv.copy(nil)
            #expect(UIPasteboard.general.string == "**bold**")
            UIPasteboard.general.string = ""
            h.tv.cut(nil)
            #expect(UIPasteboard.general.string == "**bold**")
            #expect(h.display.hasPrefix(" and code"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func displayTextOnlyHoldsNoMarkers() throws {
            let h = TextFirstHarness("**bold** and `code` and [link](u)")
            #expect(h.display == "bold and code and link")
        }
    }

    @Suite struct TextFirstFlagTests {
        private func defaults() -> UserDefaults {
            let suite = "text-first-flag-\(UUID().uuidString)"
            return UserDefaults(suiteName: suite)!
        }

        @Test func offByDefaultAndPersistedFromALaunchArgument() {
            let d = defaults()
            #expect(!TextFirstFlag.enabled(defaults: d))
            TextFirstFlag.readLaunchArguments(["app", "-futo.textFirstEditor", "YES"], defaults: d)
            #expect(TextFirstFlag.enabled(defaults: d))
            // A later launch without the argument keeps the choice; NO turns it off again.
            TextFirstFlag.readLaunchArguments(["app"], defaults: d)
            #expect(TextFirstFlag.enabled(defaults: d))
            TextFirstFlag.readLaunchArguments(["app", "-futo.textFirstEditor", "NO"], defaults: d)
            #expect(!TextFirstFlag.enabled(defaults: d))
        }
    }
#endif
