package com.futo.notes.ui

import android.content.pm.PackageInfo
import android.webkit.WebView
import com.futo.notes.localization.LocalizedMessage

/**
 * Whether the editor's WebView engine can run the editor bundle — decided by
 * CAPABILITY, never by a version number (apps/android/AGENTS.md, "A WebView
 * `versionName` is not a Chromium version", records the Huawei regression that
 * forced this; github#8 is the original blank-pane bug).
 *
 * Two facts, both reported by the page itself:
 *  - `editor.html`'s ES5 preflight publishes what the engine can't parse on
 *    `window.__futoEngineUnsupported`.
 *  - the bundle sets `window.FutoEditor` when it mounts.
 *
 * [EditorHost] reads both with [ENGINE_PROBE_JS] and reduces them through
 * [editorEngineFailure]; version numbers survive only as wording in
 * [editorEngineNoticeBody].
 */

private const val BOOTED = "booted"

private const val UNSUPPORTED_PREFIX = "unsupported:"

/**
 * Asks the page what happened, in one round trip. Answers:
 *  - `booted` — `window.FutoEditor` exists, so the bundle parsed and mounted.
 *  - `unsupported:<what is missing>` — the preflight found the engine below the
 *    bundle's syntax floor.
 *  - `pending` — neither yet.
 */
internal const val ENGINE_PROBE_JS = """
(function () {
  if (window.FutoEditor) return '$BOOTED';
  if (window.__futoEngineUnsupported) return '$UNSUPPORTED_PREFIX' + window.__futoEngineUnsupported;
  return 'pending';
})()
"""

/**
 * The bundle parsed and mounted, so this engine runs the editor — the whole
 * question the gate asks. Kept here with the probe program that produces the
 * answer, so the word survives in exactly one place.
 */
internal fun editorEngineBooted(probe: String?): Boolean = probe == BOOTED

/**
 * How long after `onPageFinished` a working engine is allowed to still be
 * mounting. A cold boot (renderer start + parse/exec of the ~2 MB bundle + the
 * CodeMirror mount) costs ~0.2–0.5 s on a modern phone; this is ~20× that, so
 * the slowest supported device can't be mistaken for a broken engine. The cost
 * of the margin is only how long an unrecognized failure shows a blank pane
 * before the notice replaces it — the preflight verdict, which covers the known
 * failure, lands on the first probe instead.
 */
internal const val ENGINE_BOOT_GRACE_MS = 10_000L

/**
 * Why the engine can't run the editor, or null when nothing says it can't.
 * [isFinal] marks the probe run after [ENGINE_BOOT_GRACE_MS]: by then a working
 * engine has mounted, so a still-`pending` page never ran the bundle — the blank
 * pane of github#8 — and earns the notice even though the preflight named
 * nothing. Before that, `pending` is just "still booting".
 *
 * A null probe (`evaluateJavascript` returned nothing decodable) decides
 * nothing: a broken probe must never hide a working editor behind the notice.
 */
internal fun editorEngineFailure(probe: String?, isFinal: Boolean): String? = when {
    probe == null || probe == BOOTED -> null
    probe.startsWith(UNSUPPORTED_PREFIX) ->
        probe.substringAfter(UNSUPPORTED_PREFIX).ifBlank { "engine below the bundle's syntax floor" }
    isFinal -> "bundle never mounted"
    else -> null
}

/** The gate the editor screen reads: show [LegacyWebViewNotice] instead of the
 *  editor pane when the engine failed, or when there is no WebView provider to
 *  run it in at all. */
internal fun isEditorPaneUnavailable(hasWebViewProvider: Boolean, engineFailure: String?): Boolean =
    !hasWebViewProvider || engineFailure != null

/** The System WebView provider, or null when the device has none — the one case
 *  with nothing to probe, because a WebView can't even be constructed. */
internal fun currentWebViewProvider(): PackageInfo? = WebView.getCurrentWebViewPackage()

/**
 * Chromium major version from a WebView User-Agent string — the one version
 * number that means the same thing across providers, because every
 * Chromium-based WebView (vendor forks included) reports its engine as
 * `Chrome/<major>.…`. Informational only: it feeds the notice's wording, never
 * the decision to show it.
 */
internal fun parseChromiumMajorFromUserAgent(userAgent: String?): Int? =
    userAgent?.substringAfter("Chrome/", "")?.takeWhile { it.isDigit() }?.toIntOrNull()

/**
 * Chromium major the editor bundle needs: `vite.editor.config.ts` builds it with
 * `target: 'ES2020'`, which parses on Chromium 80+. Quoted in the notice so the
 * user knows what to aim for — the gate itself is the preflight, so this number
 * going stale can never reject a working engine.
 */
internal const val EDITOR_CHROMIUM_FLOOR_MAJOR = 80

/**
 * The notice's body text. Names the engine the way the user can act on it: what
 * failed, what is needed, what this device reports (Chromium major from the UA,
 * plus the provider package so a support report identifies a vendor WebView).
 * Pure so the wording is unit-tested — the `StorageAdoptionMessage` pattern.
 */
internal fun editorEngineNoticeMessage(
    chromiumMajor: Int?,
    providerName: String?,
    providerVersion: String?,
): LocalizedMessage {
    val provider = listOfNotNull(providerName, providerVersion).joinToString(" ")
    val arguments = buildMap<String, Any> {
        put("minimumVersion", EDITOR_CHROMIUM_FLOOR_MAJOR)
        if (chromiumMajor != null) put("currentVersion", chromiumMajor)
        if (provider.isNotBlank()) put("provider", provider)
    }
    return when {
        chromiumMajor != null && provider.isNotBlank() ->
            LocalizedMessage("editor.android.legacyWebView.body", arguments)
        provider.isNotBlank() ->
            LocalizedMessage("editor.android.legacyWebView.bodyWithoutVersion", arguments)
        chromiumMajor != null ->
            LocalizedMessage("editor.android.legacyWebView.bodyWithoutProvider", arguments)
        else -> LocalizedMessage("editor.android.legacyWebView.bodyGeneric", arguments)
    }
}
