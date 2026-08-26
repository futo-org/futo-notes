// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).
// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of
// `just check`) fails when this file drifts from the contract.

package com.futo.notes.ui

object BridgeSpec {
    /** bridge.ts BRIDGE_VERSION. EditorWebView.kt declares it in the
     *  host config it sends to `FutoEditor.initialize`; the bundle compares
     *  it with its own and posts `bridgeVersionMismatch` when they differ.
     */
    const val BRIDGE_VERSION: Int = 8

    /** Every `type` value FutoEditorOutboundMessage can carry
     *  (bridge.ts OUTBOUND_MESSAGE_TYPES). BridgeCoverageTest asserts
     *  EditorWebView.kt handles — or explicitly exempts — every one. */
    val OUTBOUND_MESSAGE_TYPES: List<String> = listOf(
        "ready",
        "initialized",
        "bridgeVersionMismatch",
        "change",
        "focus",
        "openNote",
        "openUrl",
        "findMatches",
        "pickImage",
        "cursorContext",
        "saveImageData",
        "pasteClipboardImage",
    )
}
