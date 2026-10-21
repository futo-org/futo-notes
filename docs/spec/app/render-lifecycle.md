## Render lifecycle

- The UI shell renders immediately. **Never gate first render on filesystem
  I/O.** Theme, prefs, notes, and the search index load in the background and
  apply reactively. → AGENTS.md M1 (gated render); `App.svelte` flips
  `initialized` synchronously. Native Android likewise reaches its first
  composition before reading theme/storage preferences or the migration
  journal; startup recovery then runs on `Dispatchers.IO` and applies
  reactively. → `MainActivity.onCreate`, `recoverStorageStartup`
- `plugin-fs` reads (`readTextFile`, `exists`) can hang indefinitely on a cold
  sandbox — never `await` one before first render. _(desktop Tauri; originally
  observed on the since-removed iOS Tauri shell — the native iOS app doesn't
  use `@tauri-apps/plugin-fs` at all)_
- If notes fail to load at startup (store init or vault bootstrap rejects), the
  app stays responsive: the notes-readiness promise settles as `failed` instead
  of leaving its awaiters (tab hydration → hash routing) pending forever, and
  the failure is logged (#33). → `initNotes` /
  `whenNotesReady` in src/features/notes/notes.svelte.ts,
  createAppBootstrap.svelte.ts
- Desktop cold start overlaps a read-only, content-free note listing with
  webview startup, then publishes the engine-ordered ids, titles, folders, and
  mtimes before hydrating previews/tags and starting search. Crash recovery,
  legacy migration, empty-vault seeding, and notes readiness remain gated on
  the authoritative full Rust bootstrap; the fast listing never mutates the
  vault or becomes authoritative for tab hydration. → `LocalNoteStore::startup_listing`,
  `local_notes_startup_listing`, `prefetchLocalNoteListing`, `initNotes`
- The Welcome note is seeded once per install, on the first launch into an empty
  vault. Deleting it, or emptying the vault later, never brings it back. The
  fact is kept in app data beside the search index (`<index_dir>.welcome`),
  never in the notes folder; Full reset re-arms it (#52). → `welcome_seed`,
  `LocalNoteStore::bootstrap_loading`
