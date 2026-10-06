/**
 * The census page's stand-in for `$features/notes/notes.svelte`, the app's
 * note cache (`build.mjs` resolves that import here). The wikilink plugin
 * reads the cache for two things only: to RENDER a link (its shortest unique
 * suffix, and whether it is broken) and to fill its `[[` autocomplete. Neither
 * touches what a note's bytes parse into or what a save writes, and a Svelte
 * runes module cannot be bundled by esbuild, so the stub is an empty vault:
 * every wikilink renders as broken and autocomplete offers nothing. Parsing
 * and writing `[[target]]` are exactly the app's.
 */
import { buildWikilinkIndex, type WikilinkIndex } from '$shared/note/wikilinks';
import type { NotePreview } from '$shared/types/note';

const EMPTY_INDEX = buildWikilinkIndex([]);

export function getWikilinkIndex(): WikilinkIndex {
  return EMPTY_INDEX;
}

export function getAllNotes(): NotePreview[] {
  return [];
}
