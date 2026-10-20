## Notes & files

- **The filename IS the title.** `"grocery list.md"` → title `"grocery list"`.
  No case changes, no dash→space, no transformations; only filesystem-breaking
  characters are stripped. → `sanitizeTitle`
- Notes are plain Markdown files on disk — "file over app." A note's content is
  its file's bytes; renaming a note renames its file.
- Renaming a note whose new title collides with another note suffixes the id
  (`Title` → `Title-2`, `-3`, …). A **case-only or Unicode-normalization-only**
  rename (`note`→`Note`, composed↔decomposed `café`) keeps the requested form
  and never bumps to `-2`, even on case/normalization-insensitive filesystems
  (APFS, NTFS). → `futo_notes_store::paths::unique_note_id`,
  `futo-notes-model` `rename_note`
- A note may embed images (`![](image-…)`); those image files are first-class
  vault content, not just notes. Anything that walks "the vault" for sync or
  integrity must include image blobs, not only `.md` — an image that a note
  references but that doesn't travel with it is a data-integrity bug (it leaves
  a broken `![]()` on every other device). → [sync.md](../sync.md) "Embedded
  images sync with their notes"
