import Foundation

/// A single note. `id` is the path relative to the notes root WITHOUT the
/// `.md` extension (e.g. "Specs/folder-support"). `title` is the filename
/// leaf with NO transformation.
struct NoteItem: Identifiable, Hashable {
    /// Path relative to notes root, no `.md` extension. Stable identity.
    let id: String
    /// Filename leaf, verbatim (no case/dash transformation).
    let title: String
    /// Folder portion of the id ("" when at root).
    let folder: String
    /// File modification date.
    let modified: Date
    /// ~100-char preview, newlines collapsed to spaces. Used for search
    /// filtering (plain text).
    let preview: String
    /// Multi-line, display-oriented preview (block markdown rewritten for
    /// rendering: ☐/☑ task glyphs, • bullets, tables dropped, inline emphasis
    /// kept). Rendered as an `AttributedString` in the list. See
    /// `make_rich_preview` in futo-notes-model.
    let richPreview: String
    /// Inline #tags found in the content (display only).
    let tags: [String]
}
