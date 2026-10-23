// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { unmount } from 'svelte';

import { guardEditorTimers } from '../__fixtures__/editorTimerGuard';
import { handle, mountEditor } from '../__fixtures__/milkdownEditorHarness';

guardEditorTimers();

let unmounted = false;

beforeEach(async () => {
  document.body.innerHTML = '';
  document.elementFromPoint = () => null;
  unmounted = false;
  await mountEditor();
});

afterEach(async () => {
  if (!unmounted) await unmount(handle as never);
  vi.restoreAllMocks();
});

it('removes the open table menu keyboard listener when the editor is destroyed', async () => {
  handle.openNote('table-note', '| a | b |\n| --- | --- |\n| c | d |\n');
  const view = handle.getProseMirrorView()!;
  let firstCell = -1;
  view.state.doc.descendants((node, pos) => {
    if (firstCell === -1 && node.type.name === 'table_header') firstCell = pos + 1;
  });
  expect(firstCell).toBeGreaterThan(0);
  vi.spyOn(view, 'posAtCoords').mockReturnValue({ pos: firstCell, inside: firstCell - 1 });
  const added = vi.spyOn(document, 'addEventListener');
  const removed = vi.spyOn(document, 'removeEventListener');

  view.dom.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 }));
  const grip = document.querySelector<HTMLButtonElement>('.futo-table-grip-col');
  expect(grip).not.toBeNull();
  grip!.click();
  expect(document.querySelector<HTMLElement>('.futo-table-grip-menu')?.hidden).toBe(false);

  const menuKeys = added.mock.calls.filter(
    ([type, , capture]) => type === 'keydown' && capture === true,
  );
  expect(menuKeys).toHaveLength(1);

  await unmount(handle as never);
  unmounted = true;

  expect(removed).toHaveBeenCalledWith('keydown', menuKeys[0][1], true);
});
