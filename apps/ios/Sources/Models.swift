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
    /// ~100-char preview, newlines collapsed to spaces.
    let preview: String
    /// Inline #tags found in the content (display only).
    let tags: [String]
}
