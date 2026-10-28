import { describe, expect, it } from 'vitest';

import { confirmDialog } from '$shared/dialogs/confirmDialog';
import {
  currentConfirmDialog,
  resolveConfirmDialog,
} from '$shared/dialogs/confirmDialogState.svelte';

import { throughConfirmation } from './puppetConfirm';

describe('throughConfirmation', () => {
  it('stops at the dialog, and answering it waits for what the answer started', async () => {
    const done: string[] = [];
    const act = async () => {
      if (!(await confirmDialog('Delete note "work"?', { title: 'Delete note' }))) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
      done.push('deleted');
    };

    await throughConfirmation(act);
    expect(currentConfirmDialog()?.title).toBe('Delete note');
    expect(done).toEqual([]);

    await resolveConfirmDialog(true);
    expect(done).toEqual(['deleted']);
  });

  it('an act that ends without asking simply ends', async () => {
    let ran = false;
    await throughConfirmation(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(currentConfirmDialog()).toBeNull();
  });
});
