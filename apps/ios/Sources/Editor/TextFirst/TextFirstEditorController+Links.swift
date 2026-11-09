#if FUTO_DEBUG_BUILD
    import UIKit

    // Links: a tap on an external link's glyphs opens it, a tap on a resolved wikilink opens its
    // note (neither places a caret or raises the keyboard, as on Android); wikilink completion is
    // the engine's claim shown as a list above the toolbar; the toolbar's Link item edits the
    // link under the selection.

    @MainActor
    final class TextFirstCompletionModel: ObservableObject {
        @Published var completion: EditorWikilinkCompletion?
    }

    enum TextFirstLinkTarget: Equatable {
        case url(String)
        case note(String)
    }

    extension TextFirstEditorController {
        // MARK: taps

        /// The link whose own glyphs are under `p` (the blank space past a line's end is not a link).
        func linkTarget(at p: CGPoint) -> TextFirstLinkTarget? {
            guard let manager = textView.textLayoutManager,
                let content = manager.textContentManager,
                let fragment = manager.textLayoutFragment(
                    for: CGPoint(x: p.x - inset.left, y: p.y - inset.top))
            else { return nil }
            let local = CGPoint(
                x: p.x - inset.left - fragment.layoutFragmentFrame.minX,
                y: p.y - inset.top - fragment.layoutFragmentFrame.minY)
            let base = content.offset(
                from: manager.documentRange.location, to: fragment.rangeInElement.location)
            for line in fragment.textLineFragments where line.typographicBounds.contains(local) {
                let x = local.x - line.typographicBounds.minX
                let index = line.characterIndex(
                    for: CGPoint(x: x, y: local.y - line.typographicBounds.minY))
                for candidate in [index - 1, index]
                where candidate >= 0 && candidate < line.attributedString.length {
                    let start = line.locationForCharacter(at: candidate).x
                    let end =
                        candidate + 1 < line.attributedString.length
                        ? line.locationForCharacter(at: candidate + 1).x
                        : line.typographicBounds.width
                    guard x >= start && x < end else { continue }
                    let attributes = line.attributedString.attributes(
                        at: candidate, effectiveRange: nil)
                    _ = base
                    if let url = attributes[.tfLinkURL] as? String { return .url(url) }
                    if let note = attributes[.tfWikilink] as? String { return .note(note) }
                }
            }
            return nil
        }

        func open(_ target: TextFirstLinkTarget) {
            switch target {
            case .note(let id): onOpenNote?(id)
            case .url(let url): openExternal(url)
            }
        }

        private func openExternal(_ raw: String) {
            guard let safe = Self.externalLinkURL(raw) else { return }
            PuppetVerbs.shared.recordOpen(safe.absoluteString)
            UIApplication.shared.open(safe)
            onOpenURL?(safe.absoluteString)
        }

        /// A schemeless address from the link prompt opens as HTTPS. Its source spelling stays
        /// verbatim, and explicit schemes still go through the ordinary external-open policy.
        static func externalLinkURL(_ raw: String) -> URL? {
            guard let supplied = URL(string: raw),
                let url = supplied.scheme == nil ? URL(string: "https://" + raw) : supplied,
                case .openExternally(let safe) = editorNavigationDecision(
                    for: url, isMainFrame: true, permittedFileURL: nil)
            else { return nil }
            return safe
        }

        // MARK: wikilink completion

        /// Ask the engine for the completion at the caret; none while composing.
        func refreshCompletion() {
            guard !closed, !engineBusy else { return }
            guard !engineComposing, textView.markedTextRange == nil else { return }
            guard let found = try? session.wikilinkCompletion(expected: rev) else {
                dismissedCompletionStart = nil
                setCompletion(nil)
                return
            }
            setCompletion(dismissedCompletionStart == found.range.start ? nil : found)
        }

        private func setCompletion(_ found: EditorWikilinkCompletion?) {
            guard completionModel.completion != found else { return }
            completionModel.completion = found
        }

        func dismissCompletion() {
            guard let found = completionModel.completion else { return }
            dismissedCompletionStart = found.range.start
            setCompletion(nil)
        }

        func acceptCompletion(noteId: String) {
            guard let found = completionModel.completion, found.revision == rev,
                found.candidates.contains(where: { $0.noteId == noteId })
            else { return }
            do {
                let change = try session.acceptWikilinkCompletion(
                    expected: rev, range: found.range, query: found.query, noteId: noteId)
                try accept(change)
            } catch { recover(error, context: "accept completion") }
        }

        /// The vault's note ids changed: the engine re-resolves its wikilinks and says which
        /// projections to redraw.
        func refreshNoteIds() {
            guard !closed, !engineBusy, !engineComposing else { return }
            do {
                let change = try session.refreshNoteIds()
                for projection in change.projections {
                    let from = Int(try mirror.byteToUtf16(byte: projection.range.start))
                    let to = Int(try mirror.byteToUtf16(byte: projection.range.end))
                    let specs = try session.stylePlan(expected: rev, range: projection.range)
                    TextFirstStyler.apply(
                        specs, to: storage, window: NSRange(location: from, length: to - from),
                        images: images)
                }
            } catch { recover(error, context: "note ids") }
        }

        // MARK: the Link item

        /// Edit the link under the selection, or make one from it.
        func presentLinkPrompt(localization: Localization) {
            guard !engineBusy else { return }
            finishComposition()
            guard let presenter = textView.window?.rootViewController?.topmost else { return }
            do {
                let selection = textView.selectedRange
                let bytes = try session.utf16ToDisplay(expected: rev, range: Self.range(selection))
                let link = try session.inspectLink(expected: rev, range: bytes)
                let target = link?.range ?? bytes
                let from = try mirror.byteToUtf16(byte: target.start)
                let to = try mirror.byteToUtf16(byte: target.end)
                let label = try mirror.sliceUtf16(start: from, end: to)
                let existing = link != nil
                let alert = UIAlertController(
                    title: localization.localizedText(
                        existing ? "editor.selectionToolbar.editLink" : "editor.toolbar.link"),
                    message: nil, preferredStyle: .alert)
                alert.addTextField {
                    $0.text = label
                    $0.placeholder = localization.localizedText("editor.linkPrompt.label")
                    $0.accessibilityIdentifier = "text-first-link-label"
                }
                alert.addTextField {
                    $0.text = link?.destination ?? ""
                    $0.placeholder = localization.localizedText(
                        "editor.linkPrompt.urlAccessibilityLabel")
                    $0.keyboardType = .URL
                    $0.autocapitalizationType = .none
                    $0.accessibilityIdentifier = "text-first-link-destination"
                }
                let revision = rev
                alert.addAction(
                    UIAlertAction(
                        title: localization.localizedText(
                            existing ? "editor.linkPrompt.update" : "editor.linkPrompt.add"),
                        style: .default
                    ) { [weak self, weak alert] _ in
                        let fields = alert?.textFields ?? []
                        self?.commitLink(
                            revision: revision, range: target, label: fields.first?.text ?? "",
                            destination: fields.last?.text ?? "")
                    })
                if existing {
                    alert.addAction(
                        UIAlertAction(
                            title: localization.localizedText("editor.linkPrompt.remove"),
                            style: .destructive
                        ) { [weak self] _ in
                            self?.commitLink(
                                revision: revision, range: target, label: nil, destination: "")
                        })
                }
                alert.addAction(
                    UIAlertAction(
                        title: localization.localizedText("common.actions.cancel"), style: .cancel))
                presenter.present(alert, animated: true) {
                    // The label is already supplied by the selection; start where the user types.
                    (label.isEmpty ? alert.textFields?.first : alert.textFields?.last)?
                        .becomeFirstResponder()
                }
            } catch { recover(error, context: "link prompt") }
        }

        /// A blank destination removes the link; otherwise label and destination are the engine's
        /// to spell. The prompt's revision must still be current.
        func commitLink(
            revision: UInt64, range: EditorByteRange, label: String?, destination: String
        ) {
            guard revision == rev, !closed else { return }
            do {
                let change: EditorViewChange?
                if let label, !destination.isEmpty {
                    guard !label.isEmpty else { return }
                    change = try session.editLink(
                        expected: rev, range: range, label: label, destination: destination)
                } else {
                    change = try session.setLink(expected: rev, range: range, destination: "")
                }
                if let change { try accept(change) }
            } catch { recover(error, context: "link edit") }
        }
    }

    extension UIViewController {
        var topmost: UIViewController {
            presentedViewController?.topmost ?? self
        }
    }
#endif
