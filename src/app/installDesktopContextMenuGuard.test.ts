// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { shouldSuppressContextMenu } from './installDesktopContextMenuGuard';

function element(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild!;
}

const NO_SELECTION = { isCollapsed: true, toString: () => '' } as unknown as Selection;
const TEXT_SELECTED = { isCollapsed: false, toString: () => 'some text' } as unknown as Selection;

describe('shouldSuppressContextMenu', () => {
  it('suppresses the browser menu on plain chrome', () => {
    expect(shouldSuppressContextMenu(element('<button>New</button>'), NO_SELECTION)).toBe(true);
  });

  // The editor is sacred: spellcheck suggestions, Look Up and Cut/Copy/Paste
  // all live in the native menu the editor must keep.
  it('keeps the native menu inside the editor', () => {
    const editor = element(
      '<div class="cm-editor"><div class="cm-content"><span>hi</span></div></div>',
    );
    const inner = editor.querySelector('span')!;
    expect(shouldSuppressContextMenu(inner, NO_SELECTION)).toBe(false);
  });

  it('keeps the native menu in text fields', () => {
    expect(shouldSuppressContextMenu(element('<textarea></textarea>'), NO_SELECTION)).toBe(false);
    expect(shouldSuppressContextMenu(element('<input type="text" />'), NO_SELECTION)).toBe(false);
    expect(
      shouldSuppressContextMenu(element('<div contenteditable="true"></div>'), NO_SELECTION),
    ).toBe(false);
  });

  it('keeps the native menu when there is a live selection to act on', () => {
    expect(shouldSuppressContextMenu(element('<p>note preview</p>'), TEXT_SELECTED)).toBe(false);
  });

  it('ignores non-element targets', () => {
    expect(shouldSuppressContextMenu(null, NO_SELECTION)).toBe(false);
  });
});
