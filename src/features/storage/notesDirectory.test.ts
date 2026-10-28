import { beforeEach, describe, expect, it, vi } from 'vitest';

const rust = vi.hoisted(() => ({ refusal: null as string | null }));
const confirmed = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('$lib/platform/tauri', () => ({
  puppetNotesDirRefusal: async () => rust.refusal,
  setNotesDir: vi.fn(),
  vaultDisplayPath: vi.fn(),
}));
vi.mock('$app/puppet/puppetConfirm', () => ({ throughConfirmation: confirmed }));

import { chooseNotesDirectoryVerb } from './notesDirectory';

// Which paths are refused is Rust's rule, tested in apps/tauri/src-tauri/src/puppet_notes_dir.rs.
describe('SetNotesDirectory asks Rust before it opens the confirmation (AGENTS.md M3)', () => {
  beforeEach(() => confirmed.mockClear());

  it('refuses with Rust’s reason and never reaches the confirmation', async () => {
    rust.refusal = 'refusing a path that names the release vault';
    expect(await chooseNotesDirectoryVerb({ path: '/home/q/Documents/futo-notes' })).toEqual({
      status: 403,
      body: { ok: false, error: 'refusing a path that names the release vault' },
    });
    expect(confirmed).not.toHaveBeenCalled();
  });

  it('goes through the app’s own confirmation for a path Rust accepts', async () => {
    rust.refusal = null;
    await chooseNotesDirectoryVerb({ path: '/dev/fn/.tauri-data/vault2' });
    expect(confirmed).toHaveBeenCalledOnce();
  });
});
