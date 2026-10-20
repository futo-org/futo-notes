// Fixtures shared by the local-note projection contract tests: engine metadata,
// mutation and store fakes.
import { vi } from 'vitest';
import {
  type LocalNoteMetadata,
  type LocalNoteMutation,
  type LocalNoteStore,
  type LocalNoteUpsert,
} from '$lib/localNoteStore';

export function metadata(id: string, preview = ''): LocalNoteMetadata {
  const slash = id.lastIndexOf('/');
  return {
    id,
    title: slash < 0 ? id : id.slice(slash + 1),
    folder: slash < 0 ? '' : id.slice(0, slash),
    modifiedMs: 123,
    preview,
    richPreview: preview,
    tags: [],
  };
}

export function upsert(id: string, position = 0, preview = ''): LocalNoteUpsert {
  return { note: metadata(id, preview), position };
}

export function mutation(overrides: Partial<LocalNoteMutation> = {}): LocalNoteMutation {
  return {
    upserted: [],
    removed: [],
    renamed: [],
    folders: [],
    finalId: null,
    finalFolder: null,
    relinked: [],
    warnings: [],
    ...overrides,
  };
}

export function fakeStore(overrides: Partial<LocalNoteStore> = {}): LocalNoteStore {
  return {
    startupListing: vi.fn(async () => ({ notes: [], folders: [] })),
    setSortOrder: vi.fn(async () => ({ notes: [], folders: [] })),
    bootstrap: vi.fn(async () => bootstrapResult()),
    snapshot: vi.fn(),
    inventory: vi.fn(),
    read: vi.fn(),
    exists: vi.fn(),
    save: vi.fn(),
    flushDraft: vi.fn(),
    move: vi.fn(),
    delete: vi.fn(),
    createFolder: vi.fn(),
    renameFolder: vi.fn(),
    deleteFolder: vi.fn(),
    reset: vi.fn(),
    search: vi.fn(async () => []),
    waitUntilSearchReady: vi.fn(async () => true),
    refreshExternalChanges: vi.fn(async () => mutation()),
    rescan: vi.fn(),
    ...overrides,
  } as LocalNoteStore;
}

export function bootstrapResult(notes: LocalNoteMetadata[] = []) {
  return { snapshot: { notes, folders: [] }, seeded: 0, migrated: 0, warnings: [] };
}
