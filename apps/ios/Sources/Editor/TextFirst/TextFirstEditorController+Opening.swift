#if FUTO_DEBUG_BUILD
    import UIKit

    // A long note opens in two steps. Its first screens (the engine's quick open: the first 16 KB,
    // parsed alone) show read-only at once, in the same text view, while the engine's whole open
    // runs beside them. Until it lands the view takes input but changes nothing: each key, tap and
    // Enter is queued in order, and replayed on the engine when the session attaches (never early,
    // never dropped). The engine guarantees the first screens are the whole open's byte for byte
    // and style for style, so the handover keeps the view's text, styles, scroll and touches and
    // appends the rest. Both come from one read of the file (`NoteStore.readForEditor`), so the
    // queued input always applies to the text it was made on; another writer's change after that
    // read is the session's first save's to merge or park (#392).
    // docs/spec/editor/performance/android-text-first.md.

    /// What the user did while the note opened, in the view's own coordinates (the text it showed).
    /// A key carries the range UIKit asked to replace and the selection the view had: the view
    /// does not change meanwhile, so every key is asked against the same text, and only their
    /// offsets from the selection say what each means (Backspace is the unit before the caret).
    /// A deletion also carries the frozen text it removes (how many characters it asked for).
    enum OpeningOp: Equatable {
        case replace(range: NSRange, text: String, selection: NSRange, deleted: String)
        case key(EditorParagraphKey, range: NSRange, selection: NSRange)
        case select(NSRange)
    }

    /// Why a closed editor never saw its engine session.
    struct TextFirstNeverOpened: Error {}

    extension TextFirstEditorController {
        /// True until the engine's session attaches.
        var opening: Bool { attached == nil }

        /// Draw the quick first screens and hold the toolbar's edit buttons off (Android: disabled
        /// meanwhile).
        func styleQuickView(_ quick: EditorQuickView) {
            TextFirstStyler.apply(
                quick.spans, to: storage, window: NSRange(location: 0, length: storage.length),
                images: images)
            styledThrough = storage.length
            toolbarState.disabledFormats = Self.editToolbarIds
        }

        static let editToolbarIds: Set<String> = Set(
            ToolbarSpec.groups.joined().filter { $0.action != .dismiss }.map(\.id))

        // MARK: input while opening

        func queueWhileOpening(_ range: NSRange, _ text: String) {
            let selection = textView.selectedRange
            if text == "\n" {
                openingOps.append(.key(.enter, range: range, selection: selection))
            } else {
                let frozen = storage.string as NSString
                let deleted =
                    text.isEmpty && NSMaxRange(range) <= frozen.length
                    ? frozen.substring(with: range) : ""
                openingOps.append(
                    .replace(range: range, text: text, selection: selection, deleted: deleted))
            }
        }

        // MARK: composition while opening

        /// A keyboard's composition cannot be replayed step by step, and the view must not change:
        /// the latest marked string waits with the selection it began at, and becomes ordinary
        /// committed text (one queued replacement) when the keyboard commits it.
        func holdMarkedWhileOpening(_ text: String?) {
            guard let text, !text.isEmpty else {
                openingMarked = nil
                return
            }
            openingMarked = (text, openingMarked?.selection ?? textView.selectedRange)
        }

        /// The composition ended with its marked string (`unmarkText`, or the open landing).
        func commitMarkedWhileOpening() {
            guard let held = openingMarked else { return }
            openingMarked = nil
            queueWhileOpening(held.selection, held.text)
        }

        /// Text inserted while a composition is held replaces it (a pinyin candidate).
        func insertWhileOpening(_ text: String) {
            let start = openingMarked?.selection ?? textView.selectedRange
            openingMarked = nil
            queueWhileOpening(start, text)
        }

        /// A Backspace or forward Delete the keyboard made on the frozen view: the selection, or
        /// the character beside the caret as UIKit would delete it. The engine decides what
        /// goes when it replays this (`DisplayMirror.at_caret`).
        func queueDeleteWhileOpening(forward: Bool) {
            let selected = textView.selectedRange
            let text = storage.string as NSString
            var range = selected
            if selected.length == 0 {
                if forward, selected.location < text.length {
                    range = text.rangeOfComposedCharacterSequence(at: selected.location)
                } else if !forward, selected.location > 0 {
                    range = text.rangeOfComposedCharacterSequence(at: selected.location - 1)
                } else {
                    return
                }
            }
            queueWhileOpening(range, "")
        }

        func queueSelectionWhileOpening(_ range: NSRange) {
            if case .select = openingOps.last { openingOps.removeLast() }
            openingOps.append(.select(range))
        }

        // MARK: the handover

        /// The engine's open landed: keep what the view shows, append the rest of the note, then
        /// replay what the user did meanwhile.
        func attach(session: NativeEditorSession) throws {
            guard opening, !closed else { return }
            let shown = storage.length
            let quickText = quickView?.display ?? ""
            let full = try session.displayText()
            attached = session
            rev = try session.revision()
            mirror.reset(display: full)
            mirrorLength = Int(mirror.utf16Len())
            quickView = nil
            commitMarkedWhileOpening()
            let ops = openingOps
            openingOps = []
            if mirror.beginsWith(prefix: quickText) != nil, shown == quickText.utf16.count {
                let rest = try mirror.sliceUtf16(start: UInt64(shown), end: UInt64(mirrorLength))
                applying += 1
                storage.append(NSAttributedString(string: rest, attributes: Self.baseAttributes))
                applying -= 1
                replay(ops)
            } else {
                // The whole open does not begin with what was shown (the engine promises it does):
                // show the engine's text. Input made against the other text cannot be placed.
                print(
                    "text-first: quick open of \(noteId) differs from its whole open; replacing it")
                reloadFromEngine()
            }
            toolbarState.disabledFormats = []
            if toolbarInstalled { syncToolbar() }
            refreshCompletion()
            armSave()
            scheduleNextSlice()
        }

        /// Keys replay at the engine's caret, in order, as the user's own keys would have landed:
        /// the frozen view's selection never moved, the engine's did (`DisplayMirror.at_caret`).
        /// Only taps and selections are mapped, through what the engine changed so far. An edit
        /// is recorded where the key asked for it, not where the engine's smallest-change report
        /// puts it inside a run of identical characters.
        private func replay(_ ops: [OpeningOp]) {
            guard !ops.isEmpty else { return }
            replayed.clear()
            replaying = true
            defer { replaying = false }
            // The engine's selection starts at the view's: a key before any tap acts where the
            // caret already was.
            switch ops.first {
            case .replace(_, _, let selection, _)?, .key(_, _, let selection)?:
                if selection != engineSelection { reportSelection(selection) }
            default: break
            }
            for op in ops {
                switch op {
                case .select(let range): reportSelection(mapped(range))
                case .replace(let range, let text, let selection, let deleted):
                    let target = atCaret(range, selection, deleted: text.isEmpty ? deleted : nil)
                    replayNear = target.location
                    report(target, text, applied: false)
                case .key(let key, let range, let selection):
                    let target = atCaret(range, selection, deleted: nil)
                    replayNear = target.location
                    paragraphKey(key, range: target)
                }
            }
        }

        private func mapped(_ range: NSRange) -> NSRange {
            guard
                let mapped = try? replayed.map(
                    start: UInt64(range.location), end: UInt64(NSMaxRange(range)))
            else { return range }
            return NSRange(location: Int(mapped.start), length: Int(mapped.end - mapped.start))
        }

        private func atCaret(_ range: NSRange, _ selection: NSRange, deleted: String?) -> NSRange {
            guard
                let target = try? mirror.atCaret(
                    start: UInt64(range.location), end: UInt64(NSMaxRange(range)),
                    viewSelectionStart: UInt64(selection.location),
                    viewSelectionEnd: UInt64(NSMaxRange(selection)),
                    engineSelectionStart: UInt64(engineSelection.location),
                    engineSelectionEnd: UInt64(NSMaxRange(engineSelection)), deleted: deleted)
            else { return engineSelection }
            return NSRange(location: Int(target.start), length: Int(target.end - target.start))
        }

        /// The engine's open failed: nothing will attach and nothing was ever saved.
        func abandonOpening() {
            closed = true
            openingOps = []
            openingMarked = nil
            images.shutdown()
        }

        /// A leave before the engine landed: take the session when it arrives, apply what was
        /// typed, then close like any other editor (save and detach).
        func settleOpening() async -> Bool {
            guard opening, let opener else { return !opening }
            if let session = try? await opener.value { try? attach(session: session) }
            return !opening
        }
    }
#endif
