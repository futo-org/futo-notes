import type { NotePreview } from "../types";
import type { FileSystem } from "./platform/types";
import { extractTags } from "@futo-notes/shared";
import { extractHeadings } from "./searchIndex";
import { sortNotePreviews } from "./utils";
import { runPool } from "./util/pool";

// Concurrency for parallel body reads during startup scans. Matches the
// existing E2EE push/pull pool size — on iOS Tauri IPC serializes enough
// that going higher hasn't shown a measurable win.
const READ_POOL_CONCURRENCY = 8;

// ── Types ─────────────────────────────────────────────────────────────

export interface IndexedNote {
  id: string;
  title: string;
  preview: string;
  tags: string[];
  headings: string;
  body: string;
  mtime: number;
}

interface CachedNoteMeta {
  mtime: number;
  preview: string;
  tags: string[];
  headings: string;
}

interface NotePreviewCache {
  version: number;
  entries: Record<string, CachedNoteMeta>;
}

const CACHE_PATH = ".note-preview-cache.json";
const CACHE_VERSION = 1;

const TXT_MIGRATION_SENTINEL = ".txt-migration-done";

let txtMigrationDone = false;

// ── Preview ───────────────────────────────────────────────────────────

/** First 100 characters, newlines replaced with spaces. Matches Rust `make_preview`. */
export function makePreview(content: string): string {
  return content.slice(0, 100).replace(/\n/g, " ");
}

// ── .txt migration ────────────────────────────────────────────────────

/** One-way migration: rename .txt files to .md in the notes directory. */
export async function convertTxtToMd(fs: FileSystem): Promise<void> {
  const sentinel = await fs
    .readAppData(TXT_MIGRATION_SENTINEL)
    .catch(() => null);
  if (sentinel !== null) return;

  // Use listDirFiles (notes-root flat listing) rather than listAppData('.'),
  // which would pass a `.` component through plugin-fs scope checks and can
  // be rejected as a forbidden path on Tauri.
  const allEntries = await fs.listDirFiles();
  const allNames = allEntries.map((e) => e.name);
  const txtFiles = allNames.filter((f) => f.toLowerCase().endsWith(".txt"));
  if (txtFiles.length === 0) {
    await markTxtMigrationDone(fs);
    return;
  }

  const mdSet = new Set(
    allNames
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => f.toLowerCase()),
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
    await fs.writeAppData(TXT_MIGRATION_SENTINEL, "1");
  } catch {
    // Non-fatal: we'll just re-check next session.
  }
}

// ── Cache I/O ─────────────────────────────────────────────────────────

async function loadPreviewCache(fs: FileSystem): Promise<NotePreviewCache> {
  try {
    const raw = await fs.readAppData(CACHE_PATH);
    if (!raw) return { version: CACHE_VERSION, entries: {} };
    const cache = JSON.parse(raw) as NotePreviewCache;
    if (cache.version !== CACHE_VERSION)
      return { version: CACHE_VERSION, entries: {} };
    return cache;
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
}

async function savePreviewCache(
  fs: FileSystem,
  cache: NotePreviewCache,
): Promise<void> {
  try {
    await fs.writeAppData(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Non-fatal
  }
}

// ── Build helpers ─────────────────────────────────────────────────────

export function buildIndexedNote(
  id: string,
  content: string,
  mtime: number,
): IndexedNote {
  return {
    id,
    title: id,
    preview: makePreview(content),
    tags: extractTags(content),
    headings: extractHeadings(content),
    body: content,
    mtime,
  };
}

// ── Scanning ──────────────────────────────────────────────────────────

/**
 * Fresh bodies captured during a cache-miss pass. Consumers (e.g. the
 * cold search-index bootstrap) can reuse these instead of reading every
 * file a second time.
 */
export interface ScanResult {
  previews: NotePreview[];
  /** Bodies read from disk during this scan, keyed by note id. Cache hits are absent. */
  freshBodies: Map<string, string>;
}

/**
 * Fast startup scan: returns NotePreview[] sorted by mtime desc and the
 * bodies read during cache misses (so callers can feed them to the search
 * index without re-reading).
 * Uses a preview cache to avoid reading unchanged files. Cache misses run
 * through a bounded-concurrency pool so 2000 serial IPCs don't block startup.
 */
export async function scanNotePreviewsWithBodies(
  fs: FileSystem,
): Promise<ScanResult> {
  if (!txtMigrationDone) {
    await convertTxtToMd(fs);
    txtMigrationDone = true;
  }
  const cache = await loadPreviewCache(fs);
  const files = await fs.listNoteFiles();

  const previews: (NotePreview | null)[] = new Array(files.length).fill(null);
  const newEntries: Record<string, CachedNoteMeta> = {};
  const freshBodies = new Map<string, string>();
  let cacheChanged = false;

  type Miss = { id: string; mtime: number; index: number };
  const misses: Miss[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const id = file.name.replace(/\.md$/, "");
    const cached = cache.entries[id];
    if (cached && cached.mtime === file.mtime) {
      previews[i] = {
        id,
        title: id,
        preview: cached.preview,
        modificationTime: file.mtime,
        tags: cached.tags,
      };
      newEntries[id] = cached;
    } else {
      misses.push({ id, mtime: file.mtime, index: i });
    }
  }

  if (misses.length > 0) {
    cacheChanged = true;
    await runPool(
      misses,
      READ_POOL_CONCURRENCY,
      async ({ id, mtime, index }) => {
        try {
          const content = await fs.readNote(id);
          const preview = makePreview(content);
          const tags = extractTags(content);
          const headings = extractHeadings(content);
          previews[index] = {
            id,
            title: id,
            preview,
            modificationTime: mtime,
            tags,
          };
          newEntries[id] = { mtime, preview, tags, headings };
          freshBodies.set(id, content);
        } catch {
          // Slot stays null; filtered below.
        }
      },
    );
  }

  // Detect deletions (cache had entries not in current files)
  if (
    !cacheChanged &&
    Object.keys(cache.entries).length !== Object.keys(newEntries).length
  ) {
    cacheChanged = true;
  }

  if (cacheChanged) {
    await savePreviewCache(fs, { version: CACHE_VERSION, entries: newEntries });
  }

  const finalPreviews = sortNotePreviews(
    previews.filter((p): p is NotePreview => p !== null),
  );

  return { previews: finalPreviews, freshBodies };
}

/**
 * Full scan for search index rebuild. Reads all file bodies and builds
 * IndexedNote[] suitable for MiniSearch. Reads run through a bounded pool.
 *
 * Prefer `scanNotePreviewsWithBodies` → feed `freshBodies` directly to the
 * index when possible; this function is for the rare fallback where the
 * search index is missing but the preview cache is warm.
 */
export async function scanNotes(fs: FileSystem): Promise<IndexedNote[]> {
  if (!txtMigrationDone) {
    await convertTxtToMd(fs);
    txtMigrationDone = true;
  }
  const cache = await loadPreviewCache(fs);
  const files = await fs.listNoteFiles();

  const notes: (IndexedNote | null)[] = new Array(files.length).fill(null);
  const newEntries: Record<string, CachedNoteMeta> = {};
  let cacheChanged = false;

  await runPool(files, READ_POOL_CONCURRENCY, async (file, index) => {
    const id = file.name.replace(/\.md$/, "");
    try {
      const content = await fs.readNote(id);
      const cached = cache.entries[id];

      let preview: string;
      let tags: string[];
      let headings: string;

      if (cached && cached.mtime === file.mtime) {
        preview = cached.preview;
        tags = cached.tags;
        headings = cached.headings;
      } else {
        cacheChanged = true;
        preview = makePreview(content);
        tags = extractTags(content);
        headings = extractHeadings(content);
      }

      notes[index] = {
        id,
        title: id,
        preview,
        tags,
        headings,
        body: content,
        mtime: file.mtime,
      };
      newEntries[id] = { mtime: file.mtime, preview, tags, headings };
    } catch {
      // Slot stays null; filtered below.
    }
  });

  if (
    !cacheChanged &&
    Object.keys(cache.entries).length !== Object.keys(newEntries).length
  ) {
    cacheChanged = true;
  }

  if (cacheChanged) {
    await savePreviewCache(fs, { version: CACHE_VERSION, entries: newEntries });
  }

  return notes.filter((n): n is IndexedNote => n !== null);
}
