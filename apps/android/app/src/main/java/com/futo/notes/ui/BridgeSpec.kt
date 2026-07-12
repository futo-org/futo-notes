// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).
// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of
// `just check`) fails when this file drifts from the contract.

package com.futo.notes.ui

object BridgeSpec {
    /** bridge.ts BRIDGE_VERSION. EditorWebView.kt asserts the `ready`
     *  message's `version` matches this before trusting the bundle.
     */
    const val BRIDGE_VERSION: Int = 6

    /** Every `type` value FutoEditorOutboundMessage can carry
     *  (bridge.ts OUTBOUND_MESSAGE_TYPES). BridgeCoverageTest asserts
     *  EditorWebView.kt handles — or explicitly exempts — every one. */
    val OUTBOUND_MESSAGE_TYPES: List<String> = listOf(
        "ready",
        "change",
        "focus",
        "openNote",
        "openUrl",
        "pickImage",
        "cursorContext",
        "saveImageData",
        "pasteClipboardImage",
    )
}
