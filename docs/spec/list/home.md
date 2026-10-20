## Home ("For You") _(Tauri)_

- With no note open, the main pane shows a "For You" feed of recent-note cards
  (title, preview, relative modified time); tapping a card opens the note.
  Cards reorder as notes are edited. → ForYouPage.svelte
- The feed shows the **three most recently modified** notes whatever order the
  list is in — it is a recency surface, not a view of the list, so choosing a
  Name sort does not make the home cards alphabetical. The engine picks and
  orders those ids and the shell maps them onto its cache verbatim, holding no
  comparator of its own (ADR-0001). Card previews truncate to 60 characters.
  → futo-notes-store `LocalNoteStore::recent_note_ids`, forYou.ts
- Relative modified times in the desktop feed and images view and in Android
  and iOS note rows resolve through each shell's catalog-backed
  `localizedRelativeTime`. → shared/localization/localization.ts, Android
  `localization/Localization.kt`, iOS `Localization/Localization.swift`
- An empty vault shows a **"FUTO Notes"** heading. On mobile the subtitle reads
  "Create your first note to get started." with a **"Browse notes"** button
  (opens the drawer) and a **"Quick capture"** button below the feed area; on
  desktop only the subtitle "Create your first note from the sidebar to get
  started." shows (both buttons are mobile-only). → ForYouPage.svelte
- Quick capture creates a new note and opens it ready to type. Backing out of
  an untouched quick-capture note leaves no note behind. Verified on Android
  Tauri 2026-06-09.
