import { expect, it, vi } from 'vitest';
import type { EditorOutcome } from '$lib/platform/tauri/editorHost';
import { checkpointOrReload, type OutsideChangeEditor } from './checkpointOrReload';

function editor(offered: string | null, fields: Partial<OutsideChangeEditor> = {}) {
  const outcome = { offered } as EditorOutcome;
  return {
    revision: () => 1,
    checkpoint: vi.fn(async () => outcome),
    composing: () => false,
    reload: vi.fn(async () => {}),
    ...fields,
  };
}

it('reloads when the checkpoint offered nothing and the draft did not move', async () => {
  const unchanged = editor(null);
  await checkpointOrReload(unchanged);
  expect(unchanged.reload).toHaveBeenCalledOnce();
});

it('does not reload when a key lands during the checkpoint', async () => {
  let revision = 1;
  const typed = editor(null, {
    revision: () => revision,
    checkpoint: async () => {
      revision = 2;
      return { offered: null } as EditorOutcome;
    },
  });
  await checkpointOrReload(typed);
  expect(typed.reload).not.toHaveBeenCalled();
});

it('does not reload after an offer: adopted, waiting for composition, or already re-opening', async () => {
  const offered = editor('outside');
  await checkpointOrReload(offered);
  expect(offered.reload).not.toHaveBeenCalled();
});

it('does not reload while marked text is composing', async () => {
  const composing = editor(null, { composing: () => true });
  await checkpointOrReload(composing);
  expect(composing.reload).not.toHaveBeenCalled();
});
