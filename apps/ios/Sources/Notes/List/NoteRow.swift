import SwiftUI

struct NoteRow: View {
    @Environment(\.localization) private var localization
    let note: NoteItem
    /// Whether to show the folder label (true in flat search results).
    var showFolder: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(note.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Text(
                    localization.localizedRelativeTime(
                        note.modified.timeIntervalSince1970 * 1_000
                    )
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            if showFolder && !note.folder.isEmpty {
                Label(note.folder, systemImage: "folder")
                    .font(.caption2)
                    .foregroundStyle(Theme.primary)
            }
            if !note.richPreview.isEmpty {
                Text(richPreview)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
        .padding(.vertical, 2)
    }

    /// The rich preview rendered as an `AttributedString`: inline `**bold**` /
    /// `*italic*` / `` `code` `` become real styling, and line breaks are kept
    /// (`.inlineOnlyPreservingWhitespace` parses only inline syntax — the block
    /// markdown was already rewritten into glyphs by `make_rich_preview`). Falls
    /// back to the raw string if markdown parsing ever fails. Link attributes
    /// the markdown parser auto-attaches to URL-shaped text are stripped —
    /// preview text sits inside a row wrapped in a NavigationLink, and an
    /// active `.link` run intercepts the tap, opening the URL instead of the
    /// note (list.md preview text must never be actionable).
    private var richPreview: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed =
            (try? AttributedString(markdown: note.richPreview, options: options))
            ?? AttributedString(note.richPreview)
        return NoteRow.stripLinkAttributes(from: parsed)
    }

    /// Removes the `.link` attribute from every run, leaving other inline
    /// styling (bold/italic/code/strikethrough) untouched. Pulled out as a
    /// static, testable helper — see `NoteRowPreviewLinksTests`.
    static func stripLinkAttributes(from attributed: AttributedString) -> AttributedString {
        var result = attributed
        for run in result.runs where run.link != nil {
            result[run.range].link = nil
        }
        return result
    }
}
