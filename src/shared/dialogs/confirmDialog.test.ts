// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { confirmDialog } from './confirmDialog';
import { currentConfirmDialog, resolveConfirmDialog } from './confirmDialogState.svelte';

describe('confirmDialog', () => {
  it('shows concurrent confirmations one at a time, each with its own labels', async () => {
    const first = confirmDialog('Copy this file?', {
      title: 'Open Markdown File',
      kind: 'warning',
      confirmLabel: 'Copy into notes',
      cancelLabel: 'Leave unchanged',
    });
    const second = confirmDialog('Second?', { title: 'Second' });

    expect(currentConfirmDialog()).toEqual({
      message: 'Copy this file?',
      title: 'Open Markdown File',
      kind: 'warning',
      confirmLabel: 'Copy into notes',
      cancelLabel: 'Leave unchanged',
    });
    resolveConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(currentConfirmDialog()).toEqual({ message: 'Second?', title: 'Second' });

    resolveConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    expect(currentConfirmDialog()).toBeNull();
  });
});
