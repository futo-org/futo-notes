// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).
// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of
// `just check`) fails when this file drifts from the contract.

enum BridgeSpec {
    static let version = 9
}

enum BridgeMessageType: String {
    case ready
    case initialized
    case bridgeVersionMismatch
    case documentLoaded
    case edited
    case flushFailed
    case externalRefused
    case change
    case focus
    case openNote
    case openUrl
    case findMatches
    case pickImage
    case cursorContext
    case saveImageData
    case pasteClipboardImage
    case formatState
    case haptic
    case blockDrag
    case blockPress
}
