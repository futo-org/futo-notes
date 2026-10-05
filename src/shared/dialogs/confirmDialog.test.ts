// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import { confirmDialog } from './confirmDialog';
import {
  currentConfirmDialog,
  resetConfirmDialogsForTest,
  resolveConfirmDialog,
} from './confirmDialogState.svelte';

afterEach(() => {
  resetConfirmDialogsForTest();
});

describe('confirmDialog', () => {
  it('queues an app-owned confirmation and resolves it from the host', async () => {
    const result = confirmDialog('Delete?', { title: 'Delete', kind: 'warning' });

    expect(currentConfirmDialog()).toEqual({
      message: 'Delete?',
      title: 'Delete',
      kind: 'warning',
    });
    resolveConfirmDialog(true);
    await expect(result).resolves.toBe(true);
  });

  it('shows concurrent confirmations one at a time', async () => {
    const first = confirmDialog('First?', { title: 'First' });
    const second = confirmDialog('Second?', { title: 'Second' });

    expect(currentConfirmDialog()?.title).toBe('First');
    resolveConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(currentConfirmDialog()?.title).toBe('Second');

    resolveConfirmDialog(true);
    await expect(second).resolves.toBe(true);
  });

  it('carries action-specific button labels to the modal host', async () => {
    const result = confirmDialog('Copy this file?', {
      title: 'Open Markdown File',
      confirmLabel: 'Copy into notes',
      cancelLabel: 'Leave unchanged',
    });

    expect(currentConfirmDialog()).toMatchObject({
      confirmLabel: 'Copy into notes',
      cancelLabel: 'Leave unchanged',
    });
    resolveConfirmDialog(false);
    await expect(result).resolves.toBe(false);
  });
});
