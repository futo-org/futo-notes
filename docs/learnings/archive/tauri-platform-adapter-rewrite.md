# Tauri platform adapter rewrite lessons

Historical result; current contracts live in the platform implementation and `docs/spec/`.
The original test ledger and verification transcript remain in Git:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/learnings/archive/tauri-platform-adapter-rewrite.md
```

## Ownership and watcher-start race


`src/lib/platform/tauri.ts` is now a 20-line composition boundary. It constructs exactly one
adapter and one app-config store, then exports the stable frontend facade. `PlatformFS`
intentionally gains required clipboard writing so consumers no longer import a Tauri-private
module. The implementation is owned by the narrow subsystem:

- `tauri/adapter.ts` is the single owner of adapter construction and shared lifetime state: the
  active root and watcher-start promises. It composes `PlatformFS` and owns listener lifecycle
  without owning note-domain behavior.
- `tauri/storage.ts` owns concrete text app-data and root-file plugin I/O through an injected root
  accessor; it has no ambient root state.
- `tauri/images.ts` owns concrete image import, byte-save, render-URL, MIME policy, picker
  operations, and the asset-protocol capability promise through an injected root accessor.
- `tauri/appConfig.ts` owns the `.app-config.json` schema and persistence policy through an
  injected `PlatformFS` storage boundary.
- `tauri/notesRoot.ts` owns the concrete command projection for persisted overrides and the Rust
  default-root resolver. It contains no frontend path policy.
- Clipboard writing is part of the shared `PlatformFS` boundary and is projected directly by the
  adapter; it no longer requires a Tauri-private forwarding module.

The replacement preserved all shipped command names, consumer-backed public TypeScript contracts,
persisted keys, and plugin behavior. A final consumer audit then removed four surfaces that never
represented shipped behavior: the un-emitted `menu:action` path, unused binary app-data methods,
the constant `getPlatformName()` storage method, and the facade re-export of the image-owned MIME
helper. The old implementation had one observed bug: simultaneous `onFileChange`
registrations could each invoke `fs_start_watcher` because a boolean was set only after the first
command resolved. The acceptance regression was observed failing against the old implementation
(`expected 1 invocation, received 2`); the adapter now caches the in-flight promise. No second
strike occurred, so the rewrite did not fall back to an old seam.
