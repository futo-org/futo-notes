import { beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => core);

import { tauriLocalNoteStore } from '../localNoteStore';

import { invoke } from './invoke';

describe('invoke (RC-48: nothing ill-formed reaches the IPC parser)', () => {
  beforeEach(() => {
    core.invoke.mockReset();
    core.invoke.mockResolvedValue('ok');
  });

  it('writes a lone surrogate in an argument as U+FFFD', async () => {
    await invoke('local_notes_save', { wantedId: 'a\ud800b', content: 'x\udc00' });
    expect(core.invoke).toHaveBeenCalledWith('local_notes_save', {
      wantedId: 'a\uFFFDb',
      content: 'x\uFFFD',
    });
  });

  it('passes an already well-formed payload through as the same object', async () => {
    const args = { content: 'emoji \u{1F600}\n' };
    await invoke('local_notes_save', args);
    expect(core.invoke.mock.calls[0]?.[1]).toBe(args);
  });

  it('forwards exactly the arguments it was given', async () => {
    await invoke('window_minimize');
    expect(core.invoke).toHaveBeenLastCalledWith('window_minimize');
    await invoke('x', { a: 1 }, { headers: { h: '1' } });
    expect(core.invoke).toHaveBeenLastCalledWith('x', { a: 1 }, { headers: { h: '1' } });
  });

  it('returns the command result and its rejection', async () => {
    await expect(invoke('a', { id: 1 })).resolves.toBe('ok');
    core.invoke.mockRejectedValueOnce('nope');
    await expect(invoke('a', { id: 1 })).rejects.toBe('nope');
  });

  it('the note store saves a document holding a lone surrogate as U+FFFD', async () => {
    await tauriLocalNoteStore.save(null, 'Note', 'typed \ud83d half an emoji');
    const [, args] = core.invoke.mock.calls[0] as [string, { content: string }];
    expect(args.content).toBe('typed \uFFFD half an emoji');
    await tauriLocalNoteStore.flushDraft('Note', 'base', 'draft \ude00');
    const [, draft] = core.invoke.mock.calls[1] as [string, { content: string }];
    expect(draft.content).toBe('draft \uFFFD');
  });
});
