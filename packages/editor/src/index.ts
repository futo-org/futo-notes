// The futoBridge contract (editor ↔ host).
export * from './bridge';

// The mobile markdown-toolbar manifest (items/order/icons/visibility) —
// rendered by the embed's web toolbar and codegen'd into the native shells
// (scripts/gen-toolbar-spec.ts).
export * from './toolbar';

// The canonical TypeScript copy of the deterministic note rules
// (filename/title + tags). These are the SAME rules implemented in Rust
// (`futo-notes-model`); the conformance harness (tests/conformance/*.json,
// crates/futo-notes-model/tests/conformance.rs, ./conformance.test.ts) keeps
// the two bit-for-bit identical. They live here — in the web/presentation
// layer — because the editor needs them synchronously per keystroke (tag
// highlighting, the tag bar); routing them through Tauri IPC would regress
// typing latency (migration plan, Phase 3 adversarial note).
export * from './filename';
export * from './tags';
export * from './preview';
export * from './images';
