import type { FileSystem } from './platform/types';
import { extractTags } from '$lib/rules';
// `makePreview` is the canonical preview rule, single-sourced in the editor
// package and kept bit-for-bit identical to Rust `make_preview` by the
// conformance harness (tests/conformance/preview.json). It is re-exported here
// so existing `import { makePreview } from "./notesIndex"` call sites and the
// notesIndex test keep working.
import { makePreview } from '@futo-notes/editor';

const TXT_MIGRATION_SENTINEL = '.txt-migration-done';

// ── Preview ───────────────────────────────────────────────────────────

// `makePreview` is re-exported from the canonical editor-package rule (single
// source, kept identical to Rust `make_preview` by the conformance harness).
// Re-exporting preserves the `import { makePreview } from "./notesIndex"` API
// used by callers/tests.
export { makePreview };

/**
 * Canonical list-level tag names for a note — lowercase, WITHOUT the leading
 * `#`. Mirrors the Rust `futo-notes-model::note_tags` (and the `NoteMeta.tags`
 * the `notes_scan` command returns), so optimistic cache updates produce the
 * same tag shape as a Rust scan. `extractTags` returns `#tag`; strip it.
 */
export function noteTags(content: string): string[] {
  return extractTags(content).map((t) => t.replace(/^#/, ''));
}

// ── .txt migration ────────────────────────────────────────────────────

/** One-way migration: rename .txt files to .md in the notes directory. */
export async function convertTxtToMd(fs: FileSystem): Promise<void> {
  const sentinel = await fs.readAppData(TXT_MIGRATION_SENTINEL).catch(() => null);
  if (sentinel !== null) return;

  // Use listDirFiles (notes-root flat listing) rather than listAppData('.'),
  // which would pass a `.` component through plugin-fs scope checks and can
  // be rejected as a forbidden path on Tauri.
  const allEntries = await fs.listDirFiles();
  const allNames = allEntries.map((e) => e.name);
  const txtFiles = allNames.filter((f) => f.toLowerCase().endsWith('.txt'));
  if (txtFiles.length === 0) {
    await markTxtMigrationDone(fs);
    return;
  }

  const mdSet = new Set(
    allNames.filter((f) => f.toLowerCase().endsWith('.md')).map((f) => f.toLowerCase()),
  );

  for (const txtName of txtFiles) {
    const baseName = txtName.slice(0, -4); // strip .txt
    const mdName = `${baseName}.md`;

    let target: string;
    if (mdSet.has(mdName.toLowerCase())) {
      // Collision: both name.txt and name.md exist
      target = `${baseName} (imported).md`;
      let counter = 2;
      while (mdSet.has(target.toLowerCase()) || allNames.includes(target)) {
        target = `${baseName} (imported ${counter}).md`;
        counter++;
      }
    } else {
      target = mdName;
    }

    try {
      const content = await fs.readAppData(txtName);
      if (content !== null) {
        await fs.writeAppData(target, content);
        await fs.deleteAppData(txtName);
        mdSet.add(target.toLowerCase());
      }
    } catch {
      // Skip files that can't be read/written
    }
  }

  await markTxtMigrationDone(fs);
}

async function markTxtMigrationDone(fs: FileSystem): Promise<void> {
  try {
    await fs.writeAppData(TXT_MIGRATION_SENTINEL, '1');
  } catch {
    // Non-fatal: we'll just re-check next session.
  }
}
