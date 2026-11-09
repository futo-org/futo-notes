#if DEBUG
    import Foundation
    import Testing
    import UIKit

    @testable import FutoNotesNative

    @Suite @MainActor
    struct TextFirstLinkTests {
        @Test func aSchemelessAddressOpensAsHttpsAndUnsafeSchemesStayBlocked() {
            #expect(
                TextFirstEditorController.externalLinkURL("google.com")?.absoluteString
                    == "https://google.com")
            #expect(
                TextFirstEditorController.externalLinkURL("https://google.com")?.absoluteString
                    == "https://google.com")
            #expect(TextFirstEditorController.externalLinkURL("javascript:alert(1)") == nil)
            #expect(TextFirstEditorController.externalLinkURL("file:///etc/passwd") == nil)
        }

        @Test func aLinkPromptWithSelectedTextFocusesTheDestination() async throws {
            let h = harness("beautiful")
            let presenter = UIViewController()
            h.window.rootViewController = presenter
            presenter.view.addSubview(h.tv)
            h.window.makeKeyAndVisible()
            h.select(0, 9)
            h.controller.presentLinkPrompt(localization: Localization.system())
            #expect(await h.until { presenter.presentedViewController is UIAlertController })
            let alert = try #require(presenter.presentedViewController as? UIAlertController)
            #expect(await h.until { alert.textFields?.last?.isFirstResponder == true })
            alert.dismiss(animated: false)
        }

        @Test func linkingBoldTextKeepsTheLinkAndItsFormatting() throws {
            for destination in ["google.com", "https://google.com"] {
                let h = harness("**This editor.** Is beautiful.")
                h.select(0, 4)
                let range = EditorByteRange(start: 0, end: 4)
                h.controller.commitLink(
                    revision: h.controller.rev, range: range, label: "This",
                    destination: destination)
                let link = try h.controller.session.inspectLink(
                    expected: h.controller.rev, range: range)
                #expect(link != nil, "lost link: \(h.source)")
                #expect(
                    h.controller.storage.attribute(.tfLinkURL, at: 1, effectiveRange: nil) != nil)
                #expect(h.controller.linkTarget(at: point(h, inside: "This")) != nil)
                #expect(
                    (h.controller.storage.attribute(.font, at: 1, effectiveRange: nil) as! UIFont)
                        .fontDescriptor.symbolicTraits.contains(.traitBold))
                #expect(h.controller.divergences.isEmpty)
            }
        }

        /// The harness's vault also holds a note `Other`, so a wikilink to it resolves.
        private func harness(_ source: String) -> TextFirstHarness {
            let h = TextFirstHarness(source)
            _ = try! h.store.createNote(title: "Other", folder: "", content: "other body")
            h.controller.refreshNoteIds()
            h.tv.layoutIfNeeded()
            return h
        }

        private func point(_ h: TextFirstHarness, inside word: String) -> CGPoint {
            let at = (h.tv.text as NSString).range(of: word).location + 1
            let position = h.tv.position(from: h.tv.beginningOfDocument, offset: at)!
            let rect = h.tv.caretRect(for: position)
            return CGPoint(x: rect.midX, y: rect.midY)
        }

        @Test func aTapOnALinkOrAResolvedWikilinkNamesItsTarget() {
            let h = harness("see [site](https://example.com) and [[Other]] and [[Missing]] end")
            #expect(
                h.controller.linkTarget(at: point(h, inside: "site")) == .url("https://example.com")
            )
            #expect(h.controller.linkTarget(at: point(h, inside: "Other")) == .note("Other"))
            // An unresolved wikilink and plain text are no link.
            #expect(h.controller.linkTarget(at: point(h, inside: "Missing")) == nil)
            #expect(h.controller.linkTarget(at: point(h, inside: "end")) == nil)
            var opened: [String] = []
            h.controller.onOpenNote = { opened.append($0) }
            h.controller.open(.note("Other"))
            #expect(opened == ["Other"])
        }

        @Test func typingAWikilinkOffersTheVaultsNotesAndAcceptingSpellsIt() {
            let h = harness("")
            h.type("[[Oth")
            let found = h.controller.completionModel.completion
            #expect(found?.candidates.contains { $0.noteId == "Other" } == true)
            h.controller.acceptCompletion(noteId: "Other")
            #expect(h.source.hasPrefix("[[Other]]"))
            #expect(h.controller.completionModel.completion == nil)
            #expect(h.controller.divergences.isEmpty)
        }

        @Test func dismissingACompletionKeepsItAwayUntilTheClaimChanges() {
            let h = harness("")
            h.type("[[Oth")
            #expect(h.controller.completionModel.completion != nil)
            h.controller.dismissCompletion()
            #expect(h.controller.completionModel.completion == nil)
            h.controller.refreshCompletion()
            #expect(h.controller.completionModel.completion == nil)
        }

        @Test func theLinkPromptMakesEditsAndRemovesALink() throws {
            let h = harness("a site b")
            h.select(2, 6)
            let range = try h.controller.session.utf16ToDisplay(
                expected: h.controller.rev, range: EditorUtf16Range(start: 2, end: 6))
            h.controller.commitLink(
                revision: h.controller.rev, range: range, label: "site",
                destination: "https://x.test")
            #expect(h.source.hasPrefix("a [site]("))
            let link = try h.controller.session.inspectLink(
                expected: h.controller.rev, range: range)
            #expect(link?.destination == "https://x.test")
            h.controller.commitLink(
                revision: h.controller.rev, range: link!.range, label: nil, destination: "")
            #expect(h.source.hasPrefix("a site b"))
            // A stale prompt does nothing.
            h.controller.commitLink(
                revision: h.controller.rev - 1, range: range, label: "z", destination: "u")
            #expect(h.source.hasPrefix("a site b"))
            #expect(h.controller.divergences.isEmpty)
        }
    }
#endif
