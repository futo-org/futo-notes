import { expect, it, vi } from 'vitest';

const { executeJs } = vi.hoisted(() => ({ executeJs: vi.fn() }));
vi.mock('../mcp-client.mjs', () => ({ executeJs }));
import { TauriNotesClient } from './notes-client.mjs';

it('awaits asynchronous note reads while preserving synchronous read values', async () => {
  const window = {
    __testNotes: {
      readNote: async () => 'literal markdown\r\n',
      listNoteFiles: async () => ['plain.md'],
      noteExists: async () => false,
    },
  };
  // The real bridge serializes a bare Promise as {}. Its async-script path
  // awaits an explicit async IIFE; model that transport boundary, not a note store.
  executeJs.mockImplementation(async (_ws, script) => {
    const result = new Function('window', `return (${script});`)(window);
    return JSON.parse(JSON.stringify(script.startsWith('(async ') ? await result : result));
  });
  const client = new TauriNotesClient({ name: 'read fixture', ws: {} });
  expect(await client.readNote('plain')).toBe('literal markdown\r\n');
  expect(await client.listNotes()).toEqual(['plain.md']);
  expect(await client.noteExists('missing')).toBe(false);
  expect(await client.readWebview('false')).toBe(false);
  expect(await client.readWebview('({ text: "source", count: 3 })')).toEqual({
    text: 'source',
    count: 3,
  });
});
