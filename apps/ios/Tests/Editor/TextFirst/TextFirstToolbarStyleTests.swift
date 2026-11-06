#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstToolbarStyleTests {
        private func tap(_ h: TextFirstHarness, _ id: String) {
            let item = ToolbarSpec.groups.flatMap { $0 }.first { $0.id == id }!
            h.controller.toolbar(item)
        }

        private func font(_ h: TextFirstHarness, at index: Int) -> UIFont {
            h.controller.storage.attribute(.font, at: index, effectiveRange: nil) as! UIFont
        }

        @Test func headingsAndInlineFormatsAreStyledFromTheProjection() {
            let h = TextFirstHarness("# Head\n\nplain **bold** *it* `code`")
            #expect(font(h, at: 0).pointSize == 28)
            #expect(font(h, at: 0).fontDescriptor.symbolicTraits.contains(.traitBold))
            let text = h.display as NSString
            let bold = text.range(of: "bold").location
            let plain = text.range(of: "plain").location
            #expect(font(h, at: bold).fontDescriptor.symbolicTraits.contains(.traitBold))
            #expect(!font(h, at: plain).fontDescriptor.symbolicTraits.contains(.traitBold))
            let italic = text.range(of: "it").location
            #expect(font(h, at: italic).fontDescriptor.symbolicTraits.contains(.traitItalic))
            let code = text.range(of: "code").location
            #expect(font(h, at: code).fontDescriptor.symbolicTraits.contains(.traitMonoSpace))
        }

        @Test func aHeadingToggleStylesTheLineAndTogglesBack() {
            let h = TextFirstHarness("title\n\nbody")
            h.select(0, 0)
            tap(h, "heading-1")
            #expect(h.source.hasPrefix("# title"))
            #expect(font(h, at: 0).pointSize == 28)
            tap(h, "heading-1")
            #expect(h.source.hasPrefix("title"))
            #expect(font(h, at: 0).pointSize == 17)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func formatTogglesAndTheToolbarFollowTheSelection() {
            let h = TextFirstHarness("one two three")
            h.controller.installToolbar(localization: Localization.system())
            h.controller.verifyDivergence = true
            h.select(4, 7)
            tap(h, "bold")
            #expect(h.source.hasPrefix("one **two** three"))
            #expect(h.controller.toolbarState.activeFormats.contains("bold"))
            h.select(0, 3)
            #expect(!h.controller.toolbarState.activeFormats.contains("bold"))
            #expect(h.controller.toolbarState.activeFormats.contains("paragraph"))
            #expect(!h.controller.toolbarState.disabledFormats.contains("undo"))
            tap(h, "undo")
            #expect(h.source.hasPrefix("one two three"))
            #expect(h.controller.toolbarState.disabledFormats.contains("undo"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aCollapsedBoldToggleStylesTheNextCharacter() {
            let h = TextFirstHarness("ab")
            h.select(1, 1)
            tap(h, "bold")
            let traits = (h.tv.typingAttributes[.font] as! UIFont).fontDescriptor.symbolicTraits
            #expect(traits.contains(.traitBold))
            h.type("X")
            #expect(h.source.hasPrefix("a**X**b"))
            #expect(font(h, at: 1).fontDescriptor.symbolicTraits.contains(.traitBold))
        }

        @Test func theToolbarLeavesOutTheTextControl() {
            #expect(TextFirstEditorController.hiddenToolbarItems == ["paragraph"])
        }
    }
#endif
