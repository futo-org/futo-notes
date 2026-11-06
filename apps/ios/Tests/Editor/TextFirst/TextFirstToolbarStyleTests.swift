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
            #expect(h.controller.toolbarState.disabledFormats.isSuperset(of: ["indent", "outdent"]))
            tap(h, "undo")
            #expect(h.source.hasPrefix("one two three"))
            #expect(h.controller.toolbarState.disabledFormats.contains("undo"))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func aCollapsedBoldToggleStylesTheNextCharacter() {
            let h = TextFirstHarness("ab")
            h.controller.installToolbar(localization: Localization.system())
            h.select(1, 1)
            tap(h, "bold")
            let traits = (h.tv.typingAttributes[.font] as! UIFont).fontDescriptor.symbolicTraits
            #expect(traits.contains(.traitBold))
            h.type("X")
            #expect(h.source.hasPrefix("a**X**b"))
            #expect(font(h, at: 1).fontDescriptor.symbolicTraits.contains(.traitBold))
        }

        // Mason A1: a heading keeps bold, italic and strike through restyling.
        @Test func headingEmphasisKeepsItsWeightItalicAndStrike() {
            let h = TextFirstHarness("# **b** *i* ~~s~~")
            let text = h.display as NSString
            let b = font(h, at: text.range(of: "b").location)
            #expect(b.pointSize == 28 && b.fontDescriptor.symbolicTraits.contains(.traitBold))
            let i = font(h, at: text.range(of: "i").location)
            #expect(i.fontDescriptor.symbolicTraits.contains(.traitItalic))
            #expect(i.fontDescriptor.symbolicTraits.contains(.traitBold))
            let s = h.controller.storage.attribute(
                .strikethroughStyle, at: text.range(of: "s").location, effectiveRange: nil)
            #expect(s != nil)
            tap(h, "heading-2")
            #expect(font(h, at: 0).pointSize == 24)
            #expect(font(h, at: text.range(of: "i").location).fontDescriptor.symbolicTraits.contains(.traitItalic))
        }

        // Mason A3: Backspace at a heading's start joins it up; a first-line heading becomes text.
        @Test func backspaceAtAHeadingStartJoinsOrDemotes() {
            let h = TextFirstHarness("a\n\n# Head")
            h.select(3, 3)
            h.tv.deleteBackward()
            #expect(h.source.hasPrefix("a\n# Head"))
            #expect(h.controller.divergences.isEmpty)
            let first = TextFirstHarness("# Head")
            first.select(0, 0)
            first.tv.deleteBackward()
            #expect(first.source.hasPrefix("Head"))
        }

        // Mason D1/D2: a selection across blocks lights what every body carries; code dims inline.
        @Test func selectionWideFormatsLightAndCodeDimsInlineControls() {
            let h = TextFirstHarness("**a**\n\n**b**\n\nplain")
            h.controller.installToolbar(localization: Localization.system())
            h.select(0, 4)
            #expect(h.controller.toolbarState.activeFormats.contains("bold"))
            h.select(0, 8)
            #expect(!h.controller.toolbarState.activeFormats.contains("bold"))
            let code = TextFirstHarness("```\nx\n```")
            code.controller.installToolbar(localization: Localization.system())
            code.select(0, 1)
            #expect(code.controller.toolbarState.disabledFormats.contains("bold"))
            #expect(code.controller.toolbarState.activeFormats.contains("code-block"))
        }

        @Test func theToolbarLeavesOutTheTextControl() {
            #expect(TextFirstEditorController.hiddenToolbarItems == ["paragraph"])
        }
    }
#endif
