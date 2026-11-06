#if FUTO_DEBUG_BUILD
    import UIKit

    /// Owns one open note's text view, its Rust editor session and the display mirror that
    /// converts engine changes to the view's UTF-16 units. The engine owns the note's exact
    /// bytes, every Markdown rule, history and saving; this class only reports what the
    /// platform did (TextFirstEditorController+Input.swift) and applies what the engine answers.
    @MainActor
    final class TextFirstEditorController: NSObject {
        let textView: TextFirstTextView
        let session: NativeEditorSession
        let mirror: EditorDisplayMirror
        let storage: NSTextStorage
        private(set) var noteId: String

        /// The engine's revision; every call carries it and every accepted change advances it.
        var rev: UInt64
        /// The engine's selection in view units (the view's may differ while composing).
        var engineSelection = NSRange(location: 0, length: 0)
        /// UTF-16 length of the engine's display.
        var mirrorLength: Int
        /// > 0 while this class mutates the view, so its own callbacks are ignored.
        var applying = 0
        var pendingEdit: (range: NSRange, text: String)?
        var engineComposing = false
        /// The committed-display range the live composition replaces.
        var compositionRange = NSRange(location: 0, length: 0)
        var lastMarked = ""
        private(set) var closed = false
        /// Typed since the last save the engine confirmed.
        private(set) var dirty = false
        /// Debug and tests: compare the view with the engine after every change.
        var verifyDivergence = false
        private(set) var divergences: [String] = []

        var onCheckpoint: ((FlushDraftResult) -> Void)?
        var onFailure: ((Error) -> Void)?
        var onOpenURL: ((String) -> Void)?
        var onOpenNote: ((String) -> Void)?
        /// Debug: the kill loop's typist, kept alive with the controller.
        var steadyTyper: TextFirstSteadyTyper?

        /// Display UTF-16 units already styled (the rest of a long note follows in slices).
        var styledThrough = 0
        var styleSlicePending = false
        /// The toolbar's lit and dimmed ids, from the engine's selection state.
        let toolbarState = WebEditorToolbarState()
        var toolbarInstalled = false
        let layoutDelegate = TextFirstLayoutDelegate()
        let imageRoot: URL
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

        init(
            noteId: String, session: NativeEditorSession,
            imageRoot: URL = NotesStore.resolveNotesRoot(), imageProtocols: [AnyClass]? = nil
        ) throws {
            self.noteId = noteId
            self.session = session
            self.imageRoot = imageRoot
            self.imageProtocols = imageProtocols
            let display = try session.displayText()
            rev = try session.revision()
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
            styleFirstScreen()
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

        func adoptIdentity(_ id: String) { noteId = id }

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
            try reconcile(edit, inserted: change.inserted, platform: platform)
            setSelection(
                NSRange(
                    location: Int(edit.selectionStart),
                    length: Int(edit.selectionEnd - edit.selectionStart)))
            adjustStyled(for: edit)
            restyle(change)
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
                throw EditorSessionError.InvalidRange
            }
            if (storage.string as NSString).substring(with: region) == target { return }
            applying += 1
            storage.replaceCharacters(
                in: region,
                with: NSAttributedString(string: target, attributes: Self.baseAttributes))
            applying -= 1
        }

        func setSelection(_ range: NSRange) {
            engineSelection = range
            guard textView.selectedRange != range, NSMaxRange(range) <= storage.length else {
                return
            }
            applying += 1
            textView.selectedRange = range
            applying -= 1
        }

        /// Throw away the view's text and show the engine's (a failed or refused call left them
        /// unequal, or the engine changed under us).
        func reloadFromEngine() {
            do {
                let display = try session.displayText()
                rev = try session.revision()
                mirror.reset(display: display)
                mirrorLength = display.utf16.count
                engineComposing = false
                pendingEdit = nil
                applying += 1
                textView.unmarkText()
                storage.setAttributedString(
                    NSAttributedString(string: display, attributes: Self.baseAttributes))
                applying -= 1
                styledThrough = 0
                styleFirstScreen()
                let selected = textView.selectedRange
                setSelection(
                    NSRange(
                        location: min(selected.location, mirrorLength),
                        length: min(selected.length, max(0, mirrorLength - selected.location))))
            } catch {
                onFailure?(error)
            }
        }

        /// A refused engine call. The view may be ahead of the engine, so show the engine's.
        func recover(_ error: Error, context: String) {
            print("text-first: \(context) failed: \(error)")
            reloadFromEngine()
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
            guard !closed, !engineComposing, textView.markedTextRange == nil else { return false }
            do {
                if let change = try session.paragraphKeyUtf16(
                    expected: rev, range: Self.range(range ?? textView.selectedRange), key: key)
                {
                    try accept(change)
                    return true
                }
                return !onlyIfChanged
            } catch {
                recover(error, context: "paragraph key")
                return true
            }
        }

        func undo() { history(redo: false) }
        func redo() { history(redo: true) }

        private func history(redo: Bool) {
            // Undo and Redo stay inert while marked text is pending.
            guard !closed, !engineComposing, textView.markedTextRange == nil else { return }
            do {
                if let change = try redo ? session.redo(expected: rev) : session.undo(expected: rev)
                {
                    try accept(change)
                }
            } catch {
                recover(error, context: redo ? "redo" : "undo")
            }
        }

        static func range(_ r: NSRange) -> EditorUtf16Range {
            EditorUtf16Range(start: UInt64(r.location), end: UInt64(NSMaxRange(r)))
        }

        // MARK: clipboard (the engine's Markdown, not the display text)

        func byteRange(_ r: NSRange) throws -> EditorByteRange {
            try session.utf16ToDisplay(expected: rev, range: Self.range(r))
        }

        func copySelection(_ range: NSRange? = nil) {
            let r = range ?? textView.selectedRange
            guard r.length > 0, !engineComposing else { return }
            do {
                UIPasteboard.general.string = try session.copyMarkdown(
                    expected: rev, range: byteRange(r))
            } catch { recover(error, context: "copy") }
        }

        func cutSelection(_ range: NSRange? = nil) {
            let r = range ?? textView.selectedRange
            guard r.length > 0, !engineComposing else { return }
            do {
                let cut = try session.cutMarkdown(expected: rev, range: byteRange(r))
                UIPasteboard.general.string = cut.markdown
                if let change = cut.change { try accept(change) }
            } catch { recover(error, context: "cut") }
        }

        func pasteFromPasteboard(_ range: NSRange? = nil) {
            if range == nil, pasteImageFromPasteboard() { return }
            guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
            finishComposition()
            do {
                if let change = try session.pasteMarkdown(
                    expected: rev, range: byteRange(range ?? textView.selectedRange), text: text)
                {
                    try accept(change)
                }
            } catch { recover(error, context: "paste") }
        }

        // MARK: saving (the Store owns the debounce; this only wakes when it says a save is due)

        private func markDirty() {
            dirty = true
            armSave()
        }

        func armSave() {
            guard saveTimer == nil, !closed, let delay = try? session.saveDelay() else { return }
            let timer = Timer(timeInterval: max(delay, 0), repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.saveFired() }
            }
            RunLoop.main.add(timer, forMode: .common)
            saveTimer = timer
        }

        private func saveFired() {
            saveTimer = nil
            guard !closed else { return }
            runSave({ try $0.saveIfDue() })
        }

        /// Write now, ahead of the debounce (the app is going to the background).
        func checkpoint(then done: @escaping () -> Void = {}) {
            guard !closed else { return done() }
            saveTimer?.invalidate()
            saveTimer = nil
            finishComposition()
            runSave({ try $0.checkpoint() }, then: done)
        }

        private func runSave(
            _ save: @escaping @Sendable (NativeEditorSession) throws -> FlushDraftResult?,
            then done: @escaping () -> Void = {}
        ) {
            let session = session
            io.async { [weak self] in
                let result = Result { try save(session) }
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        self?.saved(result)
                        done()
                    }
                }
            }
        }

        private func saved(_ result: Result<FlushDraftResult?, Error>) {
            switch result {
            case .success(let flushed):
                if let flushed {
                    dirty = false
                    onCheckpoint?(flushed)
                    drainCoordinatedChanges()
                }
            case .failure(let error):
                onFailure?(error)
            }
            armSave()
        }

        /// Own-action changes (a relink after a rename) the Store queued for this session.
        func drainCoordinatedChanges() {
            guard !closed, !engineComposing else { return }
            do {
                for change in try session.takeCoordinatedChanges() {
                    guard change.previousRevision == rev else {
                        reloadFromEngine()
                        return
                    }
                    try accept(change)
                }
            } catch { recover(error, context: "coordinated changes") }
        }

        /// Save, then release the attachment. A failed detach leaves the session attached.
        func close() async -> Result<FlushDraftResult, Error> {
            finishComposition()
            saveTimer?.invalidate()
            saveTimer = nil
            let session = session
            let result: Result<FlushDraftResult, Error> = await withCheckedContinuation { done in
                io.async { done.resume(returning: Result { try session.detach() }) }
            }
            switch result {
            case .success:
                closed = true
                images.shutdown()
            case .failure: armSave()
            }
            return result
        }
    }
#endif
