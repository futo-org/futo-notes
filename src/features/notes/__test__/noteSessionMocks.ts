// Module mocks the noteSession unit tests share. A test file imports this
// first, before the modules under test, so the mocks are in place when they load.
import { vi } from 'vitest';

vi.mock('$lib/platform', () => ({
  hasFileSystem: true,
}));
vi.mock('$features/sync/autoSync', () => ({ notifySaved: vi.fn() }));
vi.mock('$features/sync/syncServiceE2ee', () => ({
  classifyOpenNote: vi.fn(async () => ({ kind: 'close' })),
}));

vi.mock('../notes.svelte', () => ({
  updateNote: vi.fn(),
  // Missing reads as "" on every platform (Tauri notes_read, web.ts, nodeFS) —
  // read_note never throws for a missing file. The default mirrors that; tests
  // that need specific bytes queue them with mockResolvedValueOnce.
  readNote: vi.fn(async () => ''),
  createNote: vi.fn(async (id: string) => ({ id, mtime: 0 })),
  getNoteById: vi.fn(() => undefined),
  _applyLocalMutation: vi.fn(),
  recordSaveIdentityChange: vi.fn(),
  handleExternalFileChange: vi.fn(async () => {}),
  refreshNotesFromStorage: vi.fn(async () => {}),
}));
