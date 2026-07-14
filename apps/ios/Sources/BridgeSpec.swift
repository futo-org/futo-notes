// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/editor/src/bridge.ts (@futo-notes/editor).
// Regenerate: `just bridge-spec`. `just bridge-spec-check` (part of
// `just check`) fails when this file drifts from the contract.

enum BridgeSpec {
    static let version = 6
}

enum BridgeMessageType: String, CaseIterable {
    case ready
    case change
    case focus
    case openNote
    case openUrl
    case pickImage
    case cursorContext
    case saveImageData
    case pasteClipboardImage
}
