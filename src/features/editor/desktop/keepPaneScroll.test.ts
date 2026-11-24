// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { keepPaneScroll } from './keepPaneScroll';

function pane(): { scroller: HTMLElement; editor: HTMLElement } {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const editor = document.createElement('div');
  scroller.append(editor);
  document.body.append(scroller);
  scroller.scrollTop = 480;
  return { scroller, editor };
}

describe('re-opening the open note', () => {
  it('leaves the pane scrolled where the reader was', async () => {
    const { scroller, editor } = pane();
    await keepPaneScroll(editor, async () => {
      scroller.scrollTop = 0;
    });
    expect(scroller.scrollTop).toBe(480);
  });

  it('puts the scroll back when the re-open fails', async () => {
    const { scroller, editor } = pane();
    const failing = keepPaneScroll(editor, async () => {
      scroller.scrollTop = 0;
      throw new Error('read failed');
    });
    await expect(failing).rejects.toThrow('read failed');
    expect(scroller.scrollTop).toBe(480);
  });
});
