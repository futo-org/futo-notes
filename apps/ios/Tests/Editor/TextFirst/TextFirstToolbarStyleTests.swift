#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstToolbarStyleTests {
        @Test func indentControlsStayVisibleInCodeAndPlainText() {
            for source in ["plain", "```\ncode\n```"] {
                let h = TextFirstHarness(source)
                h.controller.installToolbar(localization: Localization.system())
                h.select(0, 0)
                #expect(h.controller.toolbarState.inContainer == true)
            }
        }

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
            #expect(
                h.controller.toolbarState.disabledFormats.isSuperset(of: ["indent", "outdent"]))
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

        // A collapsed Strike toggle changes what the next character will be, like Bold: the view's
        // typing attributes carry the strike, so a character UIKit inserts is struck as typed and
        // not only once the engine's restyle reaches it.
        @Test func aCollapsedStrikeToggleCarriesIntoTypingAttributesAndTheWholeWord() {
            let h = TextFirstHarness("first\n")
            h.controller.installToolbar(localization: Localization.system())
            h.select(6, 6)
            tap(h, "strikethrough")
            #expect(h.tv.typingAttributes[.strikethroughStyle] != nil)
            h.type("word")
            #expect(h.source.hasPrefix("first\n~~word~~"))
            for index in 6..<10 {
                #expect(
                    h.controller.storage.attribute(
                        .strikethroughStyle, at: index, effectiveRange: nil) != nil,
                    "no strike at \(index)")
            }
            tap(h, "strikethrough")
            #expect(h.tv.typingAttributes[.strikethroughStyle] == nil)
        }

        // The keyboard's double-space period, as UIKit delivers it: the trailing space is replaced
        // by "." (the delegate is asked for a space typed at the caret, then the text changes),
        // then a space is typed. A collapsed Italic toggle keeps the next sentence italic.
        @Test func aDoubleSpacePeriodKeepsACollapsedItalicGoing() {
            let h = TextFirstHarness("")
            h.controller.installToolbar(localization: Localization.system())
            h.select(0, 0)
            tap(h, "italic")
            h.type("hello world ")
            let space = h.tv.textRange(
                from: h.tv.position(from: h.tv.beginningOfDocument, offset: 11)!,
                to: h.tv.position(from: h.tv.beginningOfDocument, offset: 12)!)!
            h.tv.replace(space, withText: ".")
            h.type(" next")
            #expect(h.source.hasPrefix("*hello world. next*"))
            #expect(font(h, at: 14).fontDescriptor.symbolicTraits.contains(.traitItalic))
            #expect(h.controller.divergences.isEmpty)
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
            #expect(
                font(h, at: text.range(of: "i").location).fontDescriptor.symbolicTraits.contains(
                    .traitItalic))
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

        // next-steps 2: an empty heading on the note's last line has no character to carry the
        // heading's font, so the first character typed was body until the engine restyled it.
        @Test(arguments: ["abc\n", "abc\n\n", ""])
        func anEmptyHeadingOnTheLastLineStartsTheTypedLineAsAHeading(source: String) {
            let h = TextFirstHarness(source)
            h.controller.installToolbar(localization: Localization.system())
            let end = (h.tv.text as NSString).length
            h.select(end, end)
            h.type("# ")
            let typing = h.tv.typingAttributes[.font] as! UIFont
            #expect(typing.pointSize == 28, "\(source.debugDescription): typing size")
            #expect(typing.fontDescriptor.symbolicTraits.contains(.traitBold))
            h.type("H")
            let last = (h.tv.text as NSString).length - 1
            #expect(font(h, at: last).pointSize == 28, "first character typed")
            #expect(font(h, at: last).fontDescriptor.symbolicTraits.contains(.traitBold))
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func anEmptyHeadingOnTheLastLineGoesBackToBodyWithItsToggle() {
            let h = TextFirstHarness("abc\n")
            h.controller.installToolbar(localization: Localization.system())
            h.select(4, 4)
            tap(h, "heading-2")
            #expect((h.tv.typingAttributes[.font] as! UIFont).pointSize == 24)
            tap(h, "heading-2")
            let typing = h.tv.typingAttributes[.font] as! UIFont
            #expect(typing.pointSize == 17)
            #expect(!typing.fontDescriptor.symbolicTraits.contains(.traitBold))
            h.type("H")
            #expect(font(h, at: 4).pointSize == 17)
        }

        // next-steps 2: iOS draws H4 to H6 bold, but only a lit H1 to H3 kept the typing font bold,
        // so the next character in a deeper heading showed non-bold until the engine restyled it.
        @Test(arguments: [1, 2, 3, 4, 5, 6])
        func typingInAHeadingKeepsItsWeightAtEveryLevel(level: Int) {
            let marker = String(repeating: "#", count: level)
            let h = TextFirstHarness("\(marker) Head")
            h.controller.installToolbar(localization: Localization.system())
            let size = font(h, at: 0).pointSize
            for caret in [1, 2, 4] {
                h.select(caret, caret)
                let typing = h.tv.typingAttributes[.font] as! UIFont
                #expect(typing.pointSize == size, "level \(level) caret \(caret): size")
                #expect(
                    typing.fontDescriptor.symbolicTraits.contains(.traitBold),
                    "level \(level) caret \(caret): bold")
            }
            // The next line, started with Enter, is body again; and so is the line after the
            // heading's toggle goes off.
            h.select(4, 4)
            h.type("\n")
            let next = h.tv.typingAttributes[.font] as! UIFont
            #expect(!next.fontDescriptor.symbolicTraits.contains(.traitBold), "after Enter")
        }

        @Test func typingInAnH2LosesItsWeightWhenItsHeadingToggleGoesOff() {
            let h = TextFirstHarness("## Head")
            h.controller.installToolbar(localization: Localization.system())
            h.select(4, 4)
            #expect(
                (h.tv.typingAttributes[.font] as! UIFont).fontDescriptor.symbolicTraits.contains(
                    .traitBold))
            tap(h, "heading-2")
            h.select(4, 4)
            let typing = h.tv.typingAttributes[.font] as! UIFont
            #expect(!typing.fontDescriptor.symbolicTraits.contains(.traitBold))
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
