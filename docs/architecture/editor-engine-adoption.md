# Adopting the Linedown editor engine

This is the client integration map for the text-first engine. The behavioral authority is
[the portable core specs](../spec/editor/portable-core.md), especially
[the Linedown dialect](../spec/editor/portable-core/linedown.md). The detailed session,
revision, coordinate and lifetime contract is the [renderer handoff](text-first-editor-host.md),
with the [desktop transport](text-first-editor-desktop-host.md) and
[merge handling](editor-merge-consumption.md). Those contracts still apply; use the current
source types for field names rather than older examples in historical handoff material.

## Files and compatibility

No note conversion or vault migration is required for this engine. Notes remain Markdown files;
opening and dropping an unchanged session writes nothing. The store saves the edited draft's
exact bytes, including its final-newline spelling. Linedown reads existing bytes without
rewriting them to fit the dialect. Its interpretation may differ from Milkdown or other
Markdown readers: for example, each line break displays as a line break, and a setext underline
is not a heading. See the dialect's differences and [saving spec](../spec/editor/portable-core/recovery.md).
Edits and explicit commands can of course change source, and other writers can change it too.

This branch does not change the sync payload, `BRIDGE_VERSION`, or `AppState` schema; it does
change the in-process editor projection and native binding types. Rebuilding and adapting a
client is therefore necessary even though converting stored notes is not. The current desktop
Milkdown editor still appends a final newline when it edits a note; that difference remains
until desktop adopts the text-first editor. Opening the same note in different renderers can
show it differently during development; a client cutover must account for that behavior.

## Client status

| Client     | Current integration                                                                                                                                                                                                         | Work before adoption                                                                                                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust/store | `EditorSession` owns exact source and editing; `StoreEditorSession` owns the attachment and saving.                                                                                                                         | Embed through the session and store contracts; use the returned projection and changes.                                                                                                                   |
| iOS | TextKit 2 renders `NativeEditorSession` in debug and Release. | Run native acceptance when changing the engine or renderer. |
| Android | Native views render `NativeEditorSession` in both distribution flavors, debug and release. | Run native acceptance when changing the engine or renderer. |
| Desktop | The shipped UI remains Milkdown. | Native mobile cleanup does not change the desktop renderer. |

Mobile has one renderer; old editor-selection preferences and launch flags have no effect.
Mobile builds do not bundle `editor.html` or instantiate a web editor host.
Native and desktop renderer work, including physical input and device acceptance, is separate
from transport tests. Deferred capabilities are listed in the portable-core index.

## Projection changes clients must consume

The authoritative definitions are `crates/futo-notes-editor/src/types.rs`,
`crates/futo-notes-editor/src/host/style_plan.rs`,
`crates/futo-notes-ffi/src/editor/{contract,host}.rs`, and
`packages/editor/src/wasmPayloads.d.ts`.

- `ListDescription` carries `indent` (leading whitespace columns, space 1 and tab 4), `level`
  (zero-based display nesting), the literal `marker` text, `ordered`, optional `checked`, and
  `first`. `indent` and `level` are different: use `level` for nesting geometry and preserve
  the typed marker; do not derive either from a sequence number. An indented plain line has
  an empty marker. Older `depth`/`number` consumers need adaptation.
- Native style plans expose `ListRow` with `indent`, `level`, marker kind, literal `text`,
  `checked` and `first`; `Plain` is a marker kind with no marker to draw. The `Tag` span
  marks the visible `#tag` as ordinary text to decorate. Exhaustive enum consumers must handle
  both additions. iOS draws list levels and marker text from these values.
- A code block description carries optional `language`, the first info-string word in its
  original case. It is a rendering description, not a request to rewrite the fence. A renderer
  can draw a label from it; iOS draws it once per code block.
- Display changes and projection changes must both be applied even when the visible replacement
  is empty. Respect revisions, selection affinity and the UTF-8/UTF-16 boundaries in the
  [handoff](text-first-editor-host.md); do not recreate Markdown interpretation in a shell.

## Build and validation

After a change to the core or FFI, regenerate native bindings with `just build-rust-ios` and
`just build-rust-android` before building or testing native consumers. They use the required
FFI profile and generate ignored artifacts; do not edit those artifacts by hand. The native
recipes (`just ios-native`, `just android-native`, `just test-ios-native`,
`just test-android-native`) perform the appropriate rebuild. Follow the respective app's
`AGENTS.md` for device claims, native test chains and platform-specific requirements.

Run `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core` and
`node scripts/test-editor-wasm.mjs` for the engine and real WASM/store consumer. Run
`cargo test -p futo-notes-ffi` for the UniFFI contract. These checks establish core and
transport behavior; they do not replace renderer, IME, keyboard, accessibility or device
acceptance. Run `just check` for the normal repository check before merge.

## Follow-up work

Stage 5 cleanup is tracked separately in GitLab under `linedown-followups`; it is not a
stored-data migration or a prerequisite for using the session contract:

- [#427: explicit front-matter closure input](https://gitlab.futo.org/futo-notes/futo-notes/-/issues/427).
- [#428: remove old list shims and dead-code exemptions; audit unused exports](https://gitlab.futo.org/futo-notes/futo-notes/-/issues/428).
- [#429: comment cleanup and reproducible engine-size report](https://gitlab.futo.org/futo-notes/futo-notes/-/issues/429).

Two separate tag defects have the same label: [header extraction after front matter (#425)](https://gitlab.futo.org/futo-notes/futo-notes/-/issues/425)
and [tag exclusion inside link destinations (#426)](https://gitlab.futo.org/futo-notes/futo-notes/-/issues/426).
The engine's owning `AGENTS.md` already describes the current implementation. List levels,
bullet shapes, fence-language entry and iOS labels are implemented, not pending stage 5 tasks.

Implementation and validation history lives in Git and [the merge request](https://gitlab.futo.org/futo-notes/futo-notes/-/merge_requests/662);
the completed rebuild plans are retired rather than retained as a competing integration contract.
