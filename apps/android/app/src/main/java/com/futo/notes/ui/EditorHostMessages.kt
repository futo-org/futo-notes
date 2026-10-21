package com.futo.notes.ui

import android.util.Log
import android.view.HapticFeedbackConstants
import android.webkit.WebView
import android.widget.Toast
import com.futo.notes.BuildConfig
import org.json.JSONObject

internal fun EditorHost.handle(msg: JSONObject) {
    rescueEngineVerdict()
    when (msg.optString("type")) {
        // The page is alive but shows nothing until it is configured. Hand
        // it this shell's whole intent in one call; the bundle owns the
        // order it applies them in and the bridge-version policy
        // (packages/editor/src/hostBoot.ts).
        "ready" -> sendHostConfig()
        // The config landed and the note is on screen — the point where
        // this shell's per-note follow-up is meaningful.
        "initialized" -> {
            isReady = true
            // NOT a shortcut to [markEngineBooted]. It used to be one, on
            // the reasoning that only the bundle can send this — true, and
            // beside the point: `initialize(config)` is answered by the host
            // API, which exists whether or not the EDITOR came up behind it.
            // Measured on futo-api30 (Chromium 83): Milkdown's async
            // `create()` threw, `initialized` still arrived, the engine was
            // marked booted, and the note showed a blank pane with no
            // update-WebView notice. The probe is the only gate; the rescue
            // it lost is [rescueEngineVerdict], above.
            // The desired state can have moved (a sync adopt, a theme flip)
            // between sending the config and this reply; each of these is
            // deduped and so a no-op when it hasn't.
            setTheme(desiredTheme)
            setLanguage(desiredLanguageTag)
            setContent(desiredNoteId, desiredContent)
            desiredImageBaseUrl?.let { setImageBaseUrl(it) }
            desiredNotesJson?.let { setNotes(it) }
            onReady()
            if (autoFocus) focusEditor()
        }
        // A stale editor.html next to a newer binary, or the reverse — a
        // build-hygiene problem, never a shipped one (the APK carries both).
        // The bundle boots anyway; this is the developer's alarm.
        "bridgeVersionMismatch" -> {
            val hostVersion = msg.optInt("hostVersion", -1)
            val bundleVersion = msg.optInt("bundleVersion", -1)
            Log.e(
                "FutoBridgeDBG",
                "Bridge version mismatch: editor.html reports v$bundleVersion, " +
                    "native expects v$hostVersion — rebuild the editor bundle",
            )
            if (BuildConfig.DEBUG) {
                localization?.let {
                    Toast.makeText(
                        appContext,
                        it.localizedText(
                            "editor.android.bridgeVersionMismatch",
                            mapOf(
                                "editorVersion" to bundleVersion.toString(),
                                "nativeVersion" to hostVersion.toString(),
                            ),
                        ),
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
        "documentLoaded" -> {
            val id = msg.optString("noteId")
            val text = (if (msg.optString("source") == "external") externalPushed.remove(id) else pushed.remove(id)) ?: return
            val revision = msg.opt("generation") as? Number ?: return
            mailbox.loaded(id, revision.toLong(), text)
            pruneDocumentReports()
            if (id == desiredNoteId) onDocumentLoaded(id)
            if (msg.optString("source") == "external") adoptions[id]?.complete(true)
        }
        "edited" -> {
            val id = msg.opt("noteId") as? String ?: return
            val revision = msg.opt("generation") as? Number ?: return
            mailbox.edited(id, revision.toLong())
        }
        "flushFailed" -> {
            val id = msg.opt("noteId") as? String ?: return
            val token = msg.opt("flushToken") as? String ?: return
            mailbox.failed(id, token)
        }
        "externalRefused" -> {
            val id = msg.opt("noteId") as? String ?: return
            externalPushed.remove(id)
            adoptions[id]?.complete(false)
        }
        "change" -> {
            val id = msg.opt("noteId") as? String ?: return
            val c = msg.opt("content") as? String ?: return
            val revision = msg.opt("generation") as? Number ?: return
            if (mailbox.change(id, revision.toLong(), c)) {
                if (id == desiredNoteId) { desiredContent = c; lastPushedContent = c }
            }
            pruneDocumentReports()
        }
        // Keyboard show/hide is handled natively by adjustResize; focus
        // gates the native toolbar's visibility (bridge v3).
        "focus" -> editorFocused = msg.optBoolean("focused")
        // Cursor moved on/off a list line (and, additively, a blockquote)
        // — drives Indent/Outdent visibility in the native toolbar
        // (deduped editor-side). `inContainer` may be absent from an
        // older bundle, which `has()` distinguishes from an explicit
        // `false` — `optBoolean` alone can't tell those apart.
        "cursorContext" -> {
            onListLine = msg.optBoolean("onListLine")
            inContainer = if (msg.has("inContainer")) msg.optBoolean("inContainer") else null
        }
        // Which toolbar-manifest commands cover the caret (deduped
        // editor-side) — the native toolbar tints those buttons. Milkdown
        // only; the CodeMirror engine never sends it.
        "formatState" -> {
            val ids = msg.optJSONArray("active")
            activeFormats = buildSet {
                for (i in 0 until (ids?.length() ?: 0)) {
                    ids?.optString(i)?.takeIf { it.isNotEmpty() }?.let { add(it) }
                }
            }
            // QA-003: Undo/Redo grayed out with an empty prosemirror-history
            // stack. Same message, additive field (bridge.ts).
            val disabledIds = msg.optJSONArray("disabled")
            disabledFormats = buildSet {
                for (i in 0 until (disabledIds?.length() ?: 0)) {
                    disabledIds?.optString(i)?.takeIf { it.isNotEmpty() }?.let { add(it) }
                }
            }
        }
        "findMatches" -> decodeFindMatches(msg)?.let { report ->
            if (
                isCurrentFindReportOwner(
                    msg.optString("noteId").takeIf { msg.has("noteId") },
                    desiredNoteId.takeIf { attachments.current() != null },
                ) && findReportGate.accepts(report)
            ) {
                onFindMatches(report)
            }
        }
        // User tapped a RESOLVED wikilink — id is the target note's id
        // (vault-relative path sans .md) [editor.md:77].
        "openNote" -> onOpenNote(msg.optString("id"))
        // User tapped an EXTERNAL link — open it in the system browser. The
        // embed posts the URL instead of navigating, so shouldOverrideUrlLoading
        // never sees it; open it here through the SAME ACTION_VIEW path.
        "openUrl" -> {
            val url = msg.optString("url")
            if (url.isNotEmpty()) openExternalUrl(url)
        }
        // User tapped a toolbar image button; the host runs the native
        // picker and calls back via insertImage [editor.md:121].
        "pickImage" -> onPickImage(msg.optString("source"))
        // User pasted an image; the embed read the bytes (base64). Decode +
        // save into the vault off the main thread, then insertImage back.
        "saveImageData" -> {
            val data = msg.optString("data")
            val ext = msg.optString("ext")
            if (data.isNotEmpty() && ext.isNotEmpty()) onSaveImageData(data, ext)
        }
        // The embed classified the paste as an image it cannot read bytes
        // for itself (QA #006): Android's Chromium WebView exposes a
        // clipboard image copied from Photos/Files/Gallery/Drive as a
        // content:// URI riding on text/plain, not as a File, so
        // saveImageData never fires. Read the OS clipboard natively
        // instead — the same `pasteClipboardImage` round trip iOS's
        // hidden-pasteboard paste already uses.
        "pasteClipboardImage" -> onPasteClipboardImage()
        // Block-drag haptics. Both native shells mount the SAME
        // long-press block drag (blockDragMode.ts), so the three moments
        // and their feel are shared (bridge.ts HapticMessage).
        "haptic" -> performBlockDragHaptic(msg.optString("kind"))
        "blockPress" -> setBlockPressActive(msg.optBoolean("pressed"))
    }
}

/**
 * The Android half of the block-drag haptics iOS does with
 * `UIImpactFeedbackGenerator` / `UISelectionFeedbackGenerator`, mapped to
 * the closest platform constants so the two feel alike:
 *
 * - `lift`  — iOS medium impact; here [HapticFeedbackConstants.LONG_PRESS],
 *   the platform's own "you have picked this up".
 * - `move`  — iOS `selectionChanged()`; here
 *   [HapticFeedbackConstants.CLOCK_TICK], Android's picker/scrubber tick,
 *   which is the same "the bar is somewhere new" signal.
 * - `drop`  — iOS light impact; here
 *   [HapticFeedbackConstants.CONTEXT_CLICK], a lighter click than the lift.
 *
 * All three exist well below `minSdk` 28, so there is no API branching.
 * [android.view.View.performHapticFeedback] — NOT [android.os.Vibrator] —
 * because it needs no `VIBRATE` permission and honors the user's system
 * touch-feedback setting, the same way iOS's feedback generators honor
 * theirs. An unknown kind is dropped, matching iOS's `default: break`: a
 * future kind must not buzz the wrong way on an old host.
 *
 * [HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING] because
 * [setBlockPressActive] turns the WebView's own view-level haptics OFF for
 * the duration of a block press — see there. The flag skips the VIEW's
 * setting only; the user's SYSTEM touch-feedback setting is still honored,
 * because `FLAG_IGNORE_GLOBAL_SETTING` is deliberately not passed.
 */
internal fun EditorHost.performBlockDragHaptic(kind: String) {
    val constant = when (kind) {
        "lift" -> HapticFeedbackConstants.LONG_PRESS
        "move" -> HapticFeedbackConstants.CLOCK_TICK
        "drop" -> HapticFeedbackConstants.CONTEXT_CLICK
        else -> null
    }
    // Emulators and haptics-less hardware feel nothing; this log is the
    // proof of receipt there, matching the iOS shell's.
    Log.d("FutoBridgeDBG", "haptic received: $kind")
    if (constant != null) {
        webView.performHapticFeedback(
            constant,
            HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING,
        )
    }
}

/**
 * The Android half of the press-level suspension iOS does by standing
 * WKWebView's delayed text-interaction recognizers down (bridge.ts
 * `BlockPressMessage`) — and it is a MUCH smaller job here, because
 * Chromium is not WebKit.
 *
 * Measured on a moto g play 2023 (Android 13, System WebView 151), a
 * stationary hold on a block, focused and unfocused, five runs: no word
 * highlight, no selection handles, no floating Cut/Copy action mode, no
 * magnifier — the page's own defenses in `mobileBlockDnd.ts` (canceled
 * `selectstart`/`contextmenu`, re-collapsed selection, `preventDefault()`
 * on the drag's touch stream) are enough for Chromium, which — unlike
 * WebKit — lets the page have them. So none of iOS's
 * `isTextInteractionEnabled`/gesture-disabling machinery is needed here,
 * and `blockDrag` needs no host at all.
 *
 * ONE thing does leak through, and it is the whole reason this exists: the
 * WebView fires its OWN [HapticFeedbackConstants.LONG_PRESS] buzz when its
 * long-press gesture recognizer trips, 128-141 ms after the editor's `lift`
 * (measured across five holds; the recognizer fires around touch-down +
 * 480 ms against the editor's 340 ms lift). Two impacts a seventh of a
 * second apart read as a stutter, not as one pickup. The view-level flag is
 * the narrowest lever that silences it: it kills the WebView's own
 * feedback, [performBlockDragHaptic] opts past it, and a long press
 * anywhere the editor does NOT claim as a block press keeps its normal
 * buzz.
 *
 * Restored in `onPageFinished` as well as here, because a page that dies
 * mid-gesture never posts the matching `pressed: false` and the WebView
 * would stay mute for the rest of the session (the iOS shell resets in
 * `loadEditor()` for the same reason).
 */
internal fun EditorHost.setBlockPressActive(pressed: Boolean) {
    webView.isHapticFeedbackEnabled = !pressed
}
