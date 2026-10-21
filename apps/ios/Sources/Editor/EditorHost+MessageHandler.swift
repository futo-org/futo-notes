import UIKit
import WebKit
import os

extension EditorHost {
    // MARK: WKScriptMessageHandler

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
            let rawType = body["type"] as? String,
            let type = BridgeMessageType(rawValue: rawType)
        else { return }

        switch type {
        case .ready:
            // The page is alive but shows nothing until it is configured. Hand
            // it this shell's whole intent in one call; the bundle owns the
            // order it applies them in and the bridge-version policy
            // (packages/editor/src/hostBoot.ts).
            sendHostConfig()
        case .initialized:
            // The config landed and the note is on screen — the point where
            // this shell's per-note follow-up is meaningful.
            isReady = true
            #if DEBUG
                benchProbe.startIfNeeded(in: webView)
            #endif
            // The desired state can have moved (a sync adopt, a theme flip)
            // between sending the config and this reply; each of these is
            // deduped and so a no-op when it hasn't.
            updateDesired(
                noteId: desiredNoteId, content: desiredContent,
                theme: desiredTheme,
                localization: desiredLocalization
            )
            if let json = desiredNotesJson { setNotes(json) }
            if autoFocus { startAutoFocus() }
        case .bridgeVersionMismatch:
            // A stale editor.html next to a newer binary, or the reverse — a
            // build-hygiene problem, never a shipped one (the app carries both
            // in a single artifact). The bundle boots anyway; this is the
            // developer's alarm.
            let hostVersion = (body["hostVersion"] as? Int) ?? -1
            let bundleVersion = (body["bundleVersion"] as? Int) ?? -1
            let versions = "native expects v\(hostVersion), editor.html reports v\(bundleVersion)"
            EditorHost.logger.error(
                "bridge version mismatch (\(versions, privacy: .public)) — rebuild the bundle"
            )
        case .documentLoaded:
            guard let id = body["noteId"] as? String, let revision = body["generation"] as? Int,
                let text =
                    (body["source"] as? String == "external"
                        ? externalPushed.removeValue(forKey: id) : pushed.removeValue(forKey: id))
            else { return }
            mailbox.loaded(id, generation: revision, content: text)
            pruneDocumentReports()
            if id == desiredNoteId { onDocumentLoaded(id) }
            if body["source"] as? String == "external" { adoptions[id]?(true) }
        case .edited:
            guard let id = body["noteId"] as? String, let revision = body["generation"] as? Int
            else { return }
            mailbox.edited(id, generation: revision)
        case .flushFailed:
            guard let id = body["noteId"] as? String, let token = body["flushToken"] as? String
            else { return }
            mailbox.failed(id, token: token)
        case .externalRefused:
            guard let id = body["noteId"] as? String else { return }
            externalPushed.removeValue(forKey: id)
            adoptions[id]?(false)
        case .change:
            guard let id = body["noteId"] as? String, let revision = body["generation"] as? Int,
                let content = body["content"] as? String
            else { return }
            if mailbox.change(id, generation: revision, content: content) {
                if id == desiredNoteId {
                    desiredContent = content
                    lastPushedContent = content
                }
            }
            pruneDocumentReports()
        case .focus:
            let focused = (body["focused"] as? Bool) == true
            onFocusChange(focused)
            // The private WKContentView exists once focused; re-apply the
            // accessory override here in case it appeared late. Only focus
            // installs: blur leaves UIKit to remove the accessory when that
            // responder resigns, so a stale blur queued by the editor that
            // previously owned the shared WKWebView can never strip the toolbar
            // from a newly focused editor.
            if focused {
                webView.futo_overrideInputAccessoryView(toolbarAccessory)
            }
        case .cursorContext:
            // Deduped by the embed — drives Indent/Outdent visibility in the
            // native toolbar. `inContainer` is additive: `as? Bool` yields
            // nil both when the key is absent (an older bundle) and when
            // JSON parsing hands back NSNull for it, either of which the
            // toolbar reads as "fall back to onListLine".
            toolbarState.onListLine = (body["onListLine"] as? Bool) ?? false
            toolbarState.inContainer = body["inContainer"] as? Bool
        case .formatState:
            // Milkdown editor — Notion-style active-state highlight on the
            // matching toolbar button(s). Deduped by the embed. Android does the
            // same in EditorWebView.kt.
            toolbarState.activeFormats = Set(body["active"] as? [String] ?? [])
            // QA-003: Undo/Redo grayed out with an empty prosemirror-history
            // stack. Same message, same dedupe, additive field (bridge.ts).
            toolbarState.disabledFormats = Set(body["disabled"] as? [String] ?? [])
        case .haptic:
            // Milkdown editor — the long-press block-drag path posts this on
            // lift and on a COMMITTED drop (never on a
            // drop-at-source no-op or a cancel). The simulator has no
            // haptics hardware; this log is the proof of receipt there.
            let kind = (body["kind"] as? String) ?? ""
            switch kind {
            case "lift":
                liftHapticFeedback.impactOccurred()
                liftHapticFeedback.prepare()
            case "move":
                moveHapticFeedback.selectionChanged()
                moveHapticFeedback.prepare()
            case "drop":
                dropHapticFeedback.impactOccurred()
                dropHapticFeedback.prepare()
            default:
                break
            }
            EditorHost.logger.info("haptic received: \(kind, privacy: .public)")
        case .blockDrag:
            // Milkdown editor — a block is airborne (or has landed) on the
            // long-press block-drag path. Suspend the WebView's own text
            // interaction for that window: WKWebView's long-press gesture
            // otherwise magnifies the block under the finger (the system loupe)
            // and drags a caret along behind it, on top of the drag the user is
            // actually performing. This is a shell duty because the page has no
            // lever on it — bridge.ts's BlockDragMessage records what was
            // measured and rejected. The press-level suspension below has been
            // holding the delayed gestures down since touch-down; this ESCALATES
            // to the whole stack now that the gesture is committed.
            setBlockDragActive((body["active"] as? Bool) == true)
        case .blockPress:
            // Milkdown editor — a finger is DOWN on a block (or has come off
            // one) on the long-press block-drag path. Posted at
            // touch-down, which is the point of it: `blockDrag` cannot arrive
            // until the editor's 340ms timer has fired, and WKWebView's own text
            // interaction fires at ~655ms whether or not it does, so a press
            // that produced no lift used to hand the user the OS magnifier and a
            // word selection with nothing suspended at all. Only the gestures
            // that need a hold stand down here, so a tap still places a caret
            // and a double-tap still selects a word.
            setBlockPressActive((body["pressed"] as? Bool) == true)
        case .findMatches:
            if body["noteId"] as? String == desiredNoteId,
                let report = FindMatchesReport(body: body)
            {
                onFindMatches?(report)
            }
        case .openNote:
            // User tapped a RESOLVED wikilink — the bound note view navigates.
            if let id = body["id"] as? String {
                onOpenNote?(id)
            }
        case .openUrl:
            // User tapped an EXTERNAL link — open it in the system browser.
            // window.open is a no-op inside a WKWebView, and the reused editor
            // WebView must never load a non-editor URL, so it leaves the app.
            if let urlString = body["url"] as? String,
                let url = URL(string: urlString)
            {
                openEditorURLExternally(url)
            }
        case .pickImage:
            // Toolbar image button: open the native picker, save the bytes into
            // the vault root, then hand the filename back via insertImage.
            presentImagePicker(source: (body["source"] as? String) ?? "library")
        case .saveImageData:
            // Clipboard image paste: the embed read the pasted bytes (base64).
            // Decode OFF the main thread — EditorHost is @MainActor, so a
            // multi-MB base64 string decoded inline would block the UI / risk
            // the watchdog (Android decodes on Dispatchers.IO). Then save via
            // the SAME path as the picker and hand the filename back.
            if let base64 = body["data"] as? String,
                let ext = body["ext"] as? String
            {
                let targetGeneration = generation
                completionQueue.enqueue { [weak self] in
                    guard let self else { return }
                    // Decode in a detached task so it runs off the main actor.
                    // (Kept out of the `guard` condition: a trailing closure
                    // inside a guard condition fails to parse.)
                    let decoded = await Task.detached(priority: .userInitiated) {
                        Data(base64Encoded: base64)
                    }.value
                    guard let data = decoded else { return }
                    guard
                        let filename = await VaultImages.save(
                            data: data, preferredExtension: ext)
                    else { return }
                    let inserted = await self.insertImage(filename, for: targetGeneration)
                    if !inserted {
                        await VaultImages.remove(filename: filename)
                    }
                }
            }
        case .pasteClipboardImage:
            // Clipboard image paste where WKWebView hid the bitmap from the JS
            // paste event (no image File reached saveImageData), like WebKitGTK.
            // Read it off the NATIVE pasteboard, then save via the SAME path as
            // saveImageData/pickImage and hand the filename back. Prefer the raw
            // PNG/JPEG bytes (keeps the source format like the picker does);
            // otherwise re-encode UIPasteboard's UIImage as PNG. No-op when the
            // pasteboard holds no image.
            if let (data, ext) = clipboardImageData() {
                let targetGeneration = generation
                completionQueue.enqueue { [weak self] in
                    guard let self else { return }
                    guard
                        let filename = await VaultImages.save(
                            data: data, preferredExtension: ext)
                    else { return }
                    let inserted = await self.insertImage(filename, for: targetGeneration)
                    if !inserted {
                        await VaultImages.remove(filename: filename)
                    }
                }
            } else {
                EditorHost.logger.info("pasteClipboardImage: no image on the pasteboard")
            }
        }
    }
}
