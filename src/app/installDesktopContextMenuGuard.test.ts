// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  installDesktopContextMenuGuard,
  shouldSuppressContextMenu,
} from './installDesktopContextMenuGuard';

const platformState = vi.hoisted(() => ({ isMac: true, isTauri: true }));
vi.mock('$lib/platform', async (importOriginal) => {
  const mod = await importOriginal<typeof import('$lib/platform')>();
  return {
    ...mod,
    get isMac() {
      return platformState.isMac;
    },
    get isTauri() {
      return platformState.isTauri;
    },
  };
});

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
      '<div class="ProseMirror" contenteditable="true"><p><span>hi</span></p></div>',
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

describe('macOS control-click never reaches the app as a click', () => {
  let stop: (() => void) | null = null;

  afterEach(() => {
    stop?.();
    stop = null;
    document.body.innerHTML = '';
    platformState.isMac = true;
  });

  function row(): { el: HTMLElement; clicks: ReturnType<typeof vi.fn> } {
    const el = document.createElement('button');
    const clicks = vi.fn();
    el.addEventListener('click', clicks);
    el.addEventListener('dblclick', clicks);
    document.body.appendChild(el);
    return { el, clicks };
  }

  function dispatch(el: HTMLElement, type: 'click' | 'dblclick', ctrlKey: boolean): void {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ctrlKey }));
  }

  it('swallows the click a control-click produces', () => {
    stop = installDesktopContextMenuGuard();
    const { el, clicks } = row();

    dispatch(el, 'click', true);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('swallows the dblclick two control-clicks produce, which opens inline rename', () => {
    stop = installDesktopContextMenuGuard();
    const { el, clicks } = row();

    dispatch(el, 'dblclick', true);
    expect(clicks).not.toHaveBeenCalled();
  });

  it('leaves a plain click alone', () => {
    stop = installDesktopContextMenuGuard();
    const { el, clicks } = row();

    dispatch(el, 'click', false);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('leaves Ctrl+click alone off macOS, where it opens a background tab', () => {
    platformState.isMac = false;
    stop = installDesktopContextMenuGuard();
    const { el, clicks } = row();

    dispatch(el, 'click', true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('stops swallowing once uninstalled', () => {
    installDesktopContextMenuGuard()();
    const { el, clicks } = row();

    dispatch(el, 'click', true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
