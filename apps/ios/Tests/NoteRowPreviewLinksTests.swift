import Foundation
import Testing

@testable import FutoNotesNative

/// The note-list preview text sits inside a row wrapped in a NavigationLink;
/// a `.link` run there would intercept the tap and open the URL instead of
/// the note. `NoteRow.stripLinkAttributes` is the guard (list.md).
@Suite("NoteRow preview link sanitization")
struct NoteRowPreviewLinksTests {
  private static let markdownOptions = AttributedString.MarkdownParsingOptions(
    interpretedSyntax: .inlineOnlyPreservingWhitespace,
    failurePolicy: .returnPartiallyParsedIfPossible)

  @Test("strips link attributes from a URL-shaped preview")
  func stripsLinkAttribute() throws {
    let parsed = try AttributedString(
      markdown: "See https://example.com for details", options: Self.markdownOptions)
    // Sanity check on the fixture: the markdown parser itself auto-attaches a
    // link to the bare URL, which is the mechanism that caused the bug.
    #expect(parsed.runs.contains { $0.link != nil })

    let sanitized = NoteRow.stripLinkAttributes(from: parsed)
    #expect(sanitized.runs.allSatisfy { $0.link == nil })
    #expect(String(sanitized.characters) == String(parsed.characters))
  }

  @Test("leaves non-link previews unchanged")
  func leavesPlainTextUnchanged() {
    let plain = AttributedString("no links here")
    let sanitized = NoteRow.stripLinkAttributes(from: plain)
    #expect(sanitized.runs.allSatisfy { $0.link == nil })
    #expect(String(sanitized.characters) == "no links here")
  }

  @Test("preserves non-link styling such as bold runs")
  func preservesOtherAttributes() throws {
    let parsed = try AttributedString(
      markdown: "**bold** https://example.com", options: Self.markdownOptions)
    let sanitized = NoteRow.stripLinkAttributes(from: parsed)
    #expect(sanitized.runs.contains { $0.inlinePresentationIntent == .stronglyEmphasized })
    #expect(sanitized.runs.allSatisfy { $0.link == nil })
  }
}
