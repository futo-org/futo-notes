import type { NotePreview } from './types';

/**
 * Global application state using Svelte 5 runes.
 * This replaces the pub/sub store pattern with reactive state.
 */

interface AppState {
	notes: NotePreview[];
	searchQuery: string;
	currentNoteId: string | null;
}

/**
 * Reactive global state object.
 * Access properties directly - they are reactive via $state.
 */
export const appState: AppState = $state({
	notes: [],
	searchQuery: '',
	currentNoteId: null
});

/**
 * Set the notes list.
 */
export function setNotes(notes: NotePreview[]): void {
	appState.notes = notes;
}

/**
 * Set the search query.
 */
export function setSearchQuery(query: string): void {
	appState.searchQuery = query;
}

/**
 * Set the currently selected note ID.
 */
export function setCurrentNoteId(id: string | null): void {
	appState.currentNoteId = id;
}
