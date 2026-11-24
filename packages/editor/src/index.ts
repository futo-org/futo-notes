// The mobile markdown-toolbar manifest (items/order/icons/visibility) —
// codegen'd into the native shells (scripts/gen-toolbar-spec.ts); the desktop
// selection toolbar takes its block buttons from it.
export * from './toolbar';

// The canonical TypeScript copy of the deterministic note rules
// (filename/title + tags). These are the SAME rules implemented in Rust
// (`futo-notes-model`); the conformance harness (tests/conformance/*.json,
// crates/futo-notes-model/tests/conformance.rs, ./conformance.test.ts) keeps
// the two bit-for-bit identical. They live here — in the web/presentation
// layer — because the UI needs them synchronously while the user types (title
// validation, the tag bar); routing them through Tauri IPC would add a
// round-trip per keystroke.
export * from './filename';
export * from './tags';
export * from './preview';
export * from './images';

// Text leaving the editor for disk or a host is well-formed UTF-16 (RC-48, decision 16A).
export * from './wellFormed';
