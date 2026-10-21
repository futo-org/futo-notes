import { vi } from 'vitest';
import type { createNoteSession } from '../noteSession.svelte.ts';

export function typeTitle(session: ReturnType<typeof createNoteSession>, fullTitle: string): void {
  for (let i = 1; i <= fullTitle.length; i++) {
    const value = fullTitle.slice(0, i);
    const target = { value, selectionStart: value.length, setSelectionRange: vi.fn() };
    session.handleTitleInput({ target } as unknown as Event);
  }
}
