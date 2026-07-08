import type { NotePreview } from '../types';

/**
 * Build a tag index: lowercased tag → array of note IDs that have that tag.
 */
export function buildTagIndex(notes: NotePreview[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const lower = tag.toLowerCase();
      const existing = index.get(lower);
      if (existing) {
        existing.push(note.id);
      } else {
        index.set(lower, [note.id]);
      }
    }
  }
  return index;
}

/**
 * Get all unique tags sorted alphabetically (case-insensitive),
 * preserving the first-seen casing.
 */
export function getSortedTags(
  notes: NotePreview[],
): Array<{ tag: string; display: string; count: number }> {
  const index = new Map<string, { display: string; count: number }>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const lower = tag.toLowerCase();
      const existing = index.get(lower);
      if (existing) {
        existing.count++;
      } else {
        // Strip # prefix for display
        index.set(lower, { display: tag.startsWith('#') ? tag.slice(1) : tag, count: 1 });
      }
    }
  }
  return Array.from(index.entries())
    .map(([tag, { display, count }]) => ({ tag, display, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

/**
 * Get all notes that have a given tag (case-insensitive).
 */
export function getNotesForTag(notes: NotePreview[], tag: string): NotePreview[] {
  const lower = tag.toLowerCase();
  return notes.filter((note) => note.tags.some((t) => t.toLowerCase() === lower));
}

/**
 * Get all unique tag names (with # prefix) from the notes collection.
 * Used for autocomplete when adding tags.
 */
export function getAllTagNames(notes: NotePreview[]): string[] {
  const seen = new Map<string, string>();
  for (const note of notes) {
    for (const tag of note.tags) {
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.set(lower, tag.startsWith('#') ? tag.slice(1) : tag);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
