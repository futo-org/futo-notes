import UIKit

/// Owns one open note's text view, its Rust editor session and the display mirror that
/// converts engine changes to the view's UTF-16 units. The engine owns the note's exact
/// bytes, every Markdown rule, history and saving; this class only reports what the
/// platform did (TextFirstEditorController+Input.swift) and applies what the engine answers.
@MainActor
final class TextFirstEditorController: NSObject {
    let textView: TextFirstTextView
    /// The engine session; nil while a long note's quick first screens are all there is
    /// (`opening`, TextFirstEditorController+Opening.swift).
    var attached: NativeEditorSession?
    var session: NativeEditorSession {
        guard let attached else { preconditionFailure("the engine session is not attached") }
        return attached
    }
    let mirror: EditorDisplayMirror
    let storage: NSTextStorage
    var noteId: String

    /// The engine's revision; every call carries it and every accepted change advances it.
    var rev: UInt64
    /// The engine's selection in view units (the view's may differ while composing).
    var engineSelection = NSRange(location: 0, length: 0)
    /// The revision `engineSelection` was set at (its units are that display's).
    var engineSelectionRev: UInt64 = 0
    /// UTF-16 length of the engine's display.
    var mirrorLength: Int
    /// > 0 while this class mutates the view, so its own callbacks are ignored.
    var applying = 0
    var pendingEdit: (range: NSRange, text: String)?
    var engineComposing = false
    /// The committed-display range the live composition replaces.
    var compositionRange = NSRange(location: 0, length: 0)
    var lastMarked = ""
    var closed = false
    /// Typed since the last save the engine confirmed.
    var dirty = false
    /// The screen left: the leave registry runs this draft's saves (no timer, no checkpoint of
    /// its own) until a screen takes the controller back (`resumeSaving`).
    var savingYielded = false
    /// Closed by `discard()`: a save queued on `io` before it checks this and writes nothing.
    let saveFence = TextFirstSaveFence()
    /// Counts the ids the editor adopted from an engine mutation or disposition (a rename, a
    /// park). An id read off the session before such an adoption is older than it.
    var identityEpoch: UInt64 = 0
    /// Debug and tests: compare the view with the engine after every change.
    var verifyDivergence = false
    private(set) var divergences: [String] = []
    /// Debug and tests (with `verifyDivergence`): each refused engine call `recover` undid.
    var recoveries: [String] = []

    var onCheckpoint: ((FlushDraftResult) -> Void)?
    var onFailure: ((Error) -> Void)?
    /// The note this editor is attached to changed (a peer's rename, a parked conflict, this
    /// screen's own rename); the argument is the engine's id for it.
    var onIdentityChange: ((String) -> Void)?
    /// Whether the last save attempt failed (the draft is kept and retried).
    let saveModel = TextFirstSaveModel()
    var onOpenURL: ((String) -> Void)?
    var onOpenNote: ((String) -> Void)?
    /// Debug: the kill loop's typist, kept alive with the controller.
    #if FUTO_DEBUG_BUILD
        var steadyTyper: TextFirstSteadyTyper?
    #endif
    /// The first screens shown while `opening`; what the whole open must begin with.
    var quickView: EditorQuickView?
    /// Input the opening view took, replayed on the engine once it lands, in order.
    var openingOps: [OpeningOp] = []
    /// A composition (marked text) the opening view was given and has not committed: its
    /// latest string and the selection it began at. The view itself is never changed.
    var openingMarked: (text: String, selection: NSRange)?
    /// What the engine changed while those replayed, to map the next op's range through.
    let replayed = EditorPendingEdits()
    var replaying = false
    /// Where the key being replayed asked to act (engine units), for `replayed.record`.
    var replayNear = 0
    /// Large engine jobs (a toolbar command, the toolbar's state for a huge selection) running
    /// on the engine's queue; while any runs, nothing else may call the engine (it would wait
    /// on the engine's lock, on the main thread).
    var engineJobs = 0
    /// Changes the engine queued for this view that a running job kept the drain from taking.
    var drainDeferred = false
    /// The edit menu (Cut, Copy, Select All) is showing.
    var menuVisible = false
    /// Select All on a note too long for UIKit to highlight: the engine selects it all while
    /// the view's selection is the stretch around the viewport (TextFirstEditorController+SelectAll.swift).
    var selectAllClipped = false
    var selectionMenu: UIEditMenuInteraction?
    /// The engine's open, while `opening` (a leave waits for it).
    var opener: Task<NativeEditorSession, Error>?

    /// Display UTF-16 units already styled (the rest of a long note follows in slices).
    var styledThrough = 0
    /// The block facts of the note's empty last line (nil when its last line has text or no
    /// block): the extra line fragment has no characters to carry them.
    var trailingBlock: TextFirstBlockAttribute?
    var styleSlicePending = false
    /// The toolbar's lit and dimmed ids, from the engine's selection state.
    let toolbarState = EditorToolbarState()
    var toolbarInstalled = false
    let layoutDelegate = TextFirstLayoutDelegate()
    let imageBreakDelegate = TextFirstImageBreakDelegate()
    let imageRoot: URL
    /// The container width the table rows' kern was last set for (`tablesWidthChanged`).
    var tablesWidth: CGFloat = 0
    /// Each table's sideways scroll, by the display offset its table starts at.
    var tableScroll: [Int: CGFloat] = [:]
    var cellEditor: TextFirstCellEditor?
    /// Find in note: the bar's model and the engine-side bookkeeping.
    let findModel = TextFirstFindModel()
    var find = TextFirstFindState()
    var tablePan: UIPanGestureRecognizer?
    var tablePanRow: (row: NSRange, span: TextFirstTableRowSpan)?
    var tablePanOrigin: CGFloat = 0
    /// Called after every accepted engine change (the cell editor follows the engine).
    var onAccepted: (() -> Void)?
    let imageProtocols: [AnyClass]?
    lazy var images = TextFirstImages(
        controller: self, root: imageRoot, protocols: imageProtocols)
    var touchHitCheckbox = false
    /// A touch on a checkbox or link is under way: the text view must not become first responder.
    var suppressFocus = false
    let completionModel = TextFirstCompletionModel()
    var dismissedCompletionStart: UInt64?
    var linkLocalization: Localization?
    var lastDrawnSelection = NSRange(location: 0, length: 0)
    /// Our own tap recogniser, the only one allowed to act on a checkbox touch.
    var checkboxTap: UITapGestureRecognizer?
    var selectionBeforeTouch = NSRange(location: 0, length: 0)

    let io = DispatchQueue(label: "futo.textfirst.io", qos: .userInitiated)
    var saveTimer: Timer?

    static let bodyFont = UIFont.systemFont(ofSize: 17)
    static var baseAttributes: [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        return [.font: bodyFont, .foregroundColor: UIColor.label, .paragraphStyle: paragraph]
    }

    /// With `session`, the whole note. Without, `quick` is a long note's first screens: read-only
    /// until `attach(session:)` (the engine's open runs beside it).
    init(
        noteId: String, session: NativeEditorSession? = nil, quick: EditorQuickView? = nil,
        imageRoot: URL = NotesStore.resolveNotesRoot(), imageProtocols: [AnyClass]? = nil
    ) throws {
        self.noteId = noteId
        self.attached = session
        self.imageRoot = imageRoot
        self.imageProtocols = imageProtocols
        let display: String
        if let session {
            display = try session.displayText()
            rev = try session.revision()
        } else if let quick {
            display = quick.display
            rev = 0
            quickView = quick
        } else {
            preconditionFailure("an editor needs a session or a quick open")
        }
        mirror = EditorDisplayMirror(display: display)
        mirrorLength = display.utf16.count
        textView = TextFirstTextView(usingTextLayoutManager: true)
        guard
            let content = textView.textLayoutManager?.textContentManager
                as? NSTextContentStorage,
            let storage = content.textStorage
        else { preconditionFailure("TextKit 2 content storage missing") }
        self.storage = storage
        super.init()
        storage.setAttributedString(
            NSAttributedString(string: display, attributes: Self.baseAttributes))
        configureTextView()
        installTapRecognizer()
        if let quick = quickView {
            styleQuickView(quick)
        } else {
            styleFirstScreen()
        }
    }

    private func configureTextView() {
        let tv = textView
        tv.controller = self
        tv.delegate = self
        tv.isEditable = true
        tv.isSelectable = true
        tv.backgroundColor = .clear
        tv.adjustsFontForContentSizeCategory = false
        tv.font = Self.bodyFont
        tv.textColor = .label
        tv.textContainerInset = UIEdgeInsets(top: 4, left: 20, bottom: 40, right: 20)
        tv.textContainer.lineFragmentPadding = 0
        tv.alwaysBounceVertical = true
        tv.keyboardDismissMode = .interactive
        // docs/spec/editor/cursor/typing-and-ime.md: autocorrect and sentence capitalization
        // on; no red spellcheck; no inline predictions.
        tv.autocorrectionType = .yes
        tv.autocapitalizationType = .sentences
        tv.spellCheckingType = .no
        tv.inlinePredictionType = .no
        // Smart quotes and dashes would rewrite Markdown syntax as it is typed. Smart
        // insert/delete stays UIKit's: its space edits arrive as ordinary platform edits.
        tv.smartQuotesType = .no
        tv.supportsAdaptiveImageGlyph = false
        tv.smartDashesType = .no
        tv.typingAttributes = Self.baseAttributes
        tv.accessibilityIdentifier = "text-first-editor"
    }

    func setTheme(_ theme: String) {
        textView.overrideUserInterfaceStyle =
            theme == "dark" ? .dark : theme == "light" ? .light : .unspecified
    }

    // MARK: applying engine output

    /// Take one accepted engine change: advance the mirror, make the view match it, then
    /// the selection. `platform` is the edit the view already made (UIKit applied it before
    /// the engine heard), so only the difference between the two results is repainted.
    func accept(_ change: EditorViewChange, platform: (range: NSRange, text: String)? = nil)
        throws
    {
        let edit = try mirror.applyChange(
            start: change.range.start, end: change.range.end, inserted: change.inserted,
            selectionStart: change.selection.start, selectionEnd: change.selection.end)
        rev = change.revision
        mirrorLength += Int(edit.insertedUtf16) - Int(edit.end - edit.start)
        if replaying {
            try? replayed.record(
                start: edit.start, end: edit.end, insertedUtf16: edit.insertedUtf16,
                slackUtf16: edit.slackUtf16, near: UInt64(replayNear))
        }
        try reconcile(edit, inserted: change.inserted, platform: platform)
        setSelection(
            NSRange(
                location: Int(edit.selectionStart),
                length: Int(edit.selectionEnd - edit.selectionStart)))
        adjustStyled(for: edit)
        restyle(change)
        syncEmptyLineTypingAttributes()
        syncToolbar()
        refreshCompletion()
        markDirty()
        checkDivergence()
        scheduleFindRefresh()
        onAccepted?()
    }

    /// The engine answered a platform edit with no change (a dictation placeholder, an
    /// unchanged reconversion): put the view back to the engine's text.
    func rejectPlatformEdit(_ platform: (range: NSRange, text: String)) throws {
        try reconcile(nil, inserted: "", platform: platform)
        setSelection(engineSelection)
        checkDivergence()
    }

    private func reconcile(
        _ edit: EditorMirrorEdit?, inserted: String,
        platform p: (range: NSRange, text: String)?
    ) throws {
        let es: Int
        let ee: Int
        let inserts: Int
        if let edit {
            (es, ee, inserts) = (Int(edit.start), Int(edit.end), Int(edit.insertedUtf16))
        } else if let p {
            (es, ee, inserts) = (p.range.location, p.range.location, 0)
        } else {
            return
        }
        var from = es
        var to = ee
        var storageDelta = 0
        if let p {
            // The common case: UIKit made exactly the edit the engine accepted.
            if edit != nil, es == p.range.location, ee == p.range.location + p.range.length,
                inserted == p.text
            {
                return
            }
            from = min(es, p.range.location)
            to = max(ee, p.range.location + p.range.length)
            storageDelta = p.text.utf16.count - p.range.length
        }
        let target = try mirror.sliceUtf16(
            start: UInt64(from), end: UInt64(to + inserts - (ee - es)))
        let region = NSRange(location: from, length: to - from + storageDelta)
        guard NSMaxRange(region) <= storage.length else {
            throw ReconcileMismatch()
        }
        if (storage.string as NSString).substring(with: region) == target { return }
        applying += 1
        storage.replaceCharacters(
            in: region,
            with: NSAttributedString(string: target, attributes: Self.baseAttributes))
        applying -= 1
    }

    /// The view's text no longer covers the range an engine change names (a host bug, never
    /// the engine's refusal).
    struct ReconcileMismatch: Error {}

    func setSelection(_ range: NSRange) {
        engineSelection = range
        engineSelectionRev = rev
        selectAllClipped = false
        guard NSMaxRange(range) <= storage.length else { return }
        // A selection too large for UIKit to highlight is shown as the stretch around the
        // viewport (see +SelectAll).
        var shown = range
        if range.length > Self.clipSelectionAbove {
            selectAllClipped = true
            shown = clippedWindow(of: range)
        }
        guard textView.selectedRange != shown else { return }
        applying += 1
        textView.selectedRange = shown
        applying -= 1
    }

    func checkDivergence() {
        guard verifyDivergence else { return }
        let engine = mirror.text()
        if engine != storage.string, !engineComposing, textView.markedTextRange == nil {
            divergences.append(
                "view differs from the engine's display (\(storage.length) vs \(mirrorLength))")
        }
        if let engineText = try? session.displayText(), engineText != engine {
            divergences.append("mirror differs from the session's display")
        }
    }

    // MARK: commands

    /// A key the engine owns. True when it handled the key (including a no-op at the
    /// document's edge), false when UIKit should.
    @discardableResult
    func paragraphKey(
        _ key: EditorParagraphKey, range: NSRange? = nil, onlyIfChanged: Bool = false
    ) -> Bool {
        guard !closed, !engineBusy, !engineComposing, textView.markedTextRange == nil else {
            return false
        }
        let handled: Bool
        do {
            if let change = try session.paragraphKeyUtf16(
                expected: rev, range: Self.range(range ?? effectiveSelection), key: key)
            {
                try accept(change)
                handled = true
            } else {
                handled = !onlyIfChanged
            }
        } catch {
            recover(error, context: "paragraph key")
            handled = true
        }
        // The keyboard asks the delegate about a Backspace before it calls `deleteBackward`;
        // the engine took the key, so that platform edit never happens. Left pending, it would
        // hold back every selection report (the toolbar's state, the caret kept out of images)
        // until the next typed character.
        if handled { pendingEdit = nil }
        return handled
    }

    func undo() { history(redo: false) }
    func redo() { history(redo: true) }

    private func history(redo: Bool) {
        // Undo and Redo stay inert while marked text is pending, and until the engine lands.
        guard !closed, !engineBusy, !engineComposing, textView.markedTextRange == nil else {
            return
        }
        do {
            if let change = try redo ? session.redo(expected: rev) : session.undo(expected: rev) {
                try accept(change)
            }
        } catch {
            recover(error, context: redo ? "redo" : "undo")
        }
    }

    static func range(_ r: NSRange) -> EditorUtf16Range {
        EditorUtf16Range(start: UInt64(r.location), end: UInt64(NSMaxRange(r)))
    }
}
