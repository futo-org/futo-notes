import SwiftUI

/// Which shell is on screen: the phone's navigation stack, or the pages shell
/// (``DuoPagesView``) a foldable iPhone gets when it has the room.
///
/// iPhone Duo windows: closed 466 x 678 pt (portrait), 678 x 466 (landscape);
/// open 669 x 951 (tall), 951 x 669 (held like a book).
enum ShellLayout: Equatable {
    case stack
    case pages

    /// Open: at least this much on both sides. No other iPhone window gets there.
    static let pagesMinSide: CGFloat = 600
    /// Closed, in landscape: wide enough for a narrow list beside the note.
    static let miniPairMinWidth: CGFloat = 640
    /// Long side over short side below which a phone window is "squat". The Duo's outer
    /// screen is 1.46; every ordinary iPhone is 1.78 (SE) or more, so a landscape Pro Max
    /// (956 x 440 pt, 2.2) stays a phone.
    static let squatAspect: CGFloat = 1.6

    /// iPad keeps the stack on every size (its reading column handles the width).
    init(size: CGSize, idiom: UIUserInterfaceIdiom) {
        guard idiom == .phone, size.width > 0, size.height > 0 else {
            self = .stack
            return
        }
        let short = min(size.width, size.height)
        let long = max(size.width, size.height)
        if short >= Self.pagesMinSide {
            self = .pages
        } else if size.width > size.height, size.width >= Self.miniPairMinWidth,
            long / short < Self.squatAspect
        {
            self = .pages
        } else {
            self = .stack
        }
    }

    /// The closed Duo's outer screen held upright. On iOS 27.1 the system moves the status
    /// bar and the navigation bar's buttons into a rail on its right edge; the stack shows
    /// denser rows there and puts New note in the bottom bar.
    static func isDuoOuter(size: CGSize, idiom: UIUserInterfaceIdiom) -> Bool {
        idiom == .phone && size.width > 0 && size.height > size.width
            && size.height / size.width < squatAspect
    }
}

/// How the pages shell arranges itself, from the window and the hinge.
enum PagesMode: Equatable {
    /// Open, held like a book: folders and notes on the left page, the note on the right.
    case book
    /// Open, held tall and flat: the list beside the note.
    case tall
    /// Open, held tall and half-folded: the note on the upright half, the list on the flat one.
    case tabletop
    /// Closed, in landscape: a narrow list beside the note.
    case mini

    init(window: CGSize, hingeIsFlat: Bool) {
        if min(window.width, window.height) < ShellLayout.pagesMinSide {
            self = .mini
        } else if window.width > window.height {
            self = .book
        } else {
            self = hingeIsFlat ? .tall : .tabletop
        }
    }
}

extension EnvironmentValues {
    /// True on the closed Duo's outer screen held upright (``ShellLayout/isDuoOuter``).
    @Entry var isDuoOuter = false
    /// Dense note rows: two preview lines. The Duo's outer screen and the pages shell.
    @Entry var compactNoteRows = false
    /// Drop a first preview line that only repeats the note's title. Every Duo surface;
    /// never on the ordinary iPhone list.
    @Entry var dropRepeatedPreviewTitle = false
    /// Set by the pages shell; the visible note screen calls it with its note's id, which
    /// follows renames, so the list highlights the right row.
    @Entry var reportVisibleNote: ((String) -> Void)?
    /// Set by the root shell; a note screen reports the id it was opened with and the id
    /// its note has now, so a fold reopens a renamed or moved note.
    @Entry var reportNoteIdentity: ((String, String) -> Void)?
    /// Set while the root shell swaps shells (a fold): a note screen leaving then is
    /// handing its note over, not abandoning it, so an untouched new note is kept.
    @Entry var shellHandoff = ShellHandoff.idle
}

enum NotePreviewText {
    /// The preview as displayed. The preview is shared Rust (`make_rich_preview`), so the
    /// repeated-title rule is display-only, here, and the one place it lives.
    static func display(preview: String, title: String, dropRepeatedTitle: Bool) -> String {
        guard dropRepeatedTitle else { return preview }
        guard let newline = preview.firstIndex(of: "\n") else {
            return preview.trimmingCharacters(in: .whitespaces) == title ? "" : preview
        }
        let first = preview[..<newline].trimmingCharacters(in: .whitespaces)
        return first == title ? String(preview[preview.index(after: newline)...]) : preview
    }
}

/// Read when a note screen leaves, so it is a reference: the leaving screen sees the value
/// the root set in the same update that removed it.
final class ShellHandoff {
    static let idle = ShellHandoff()
    var active = false
}
