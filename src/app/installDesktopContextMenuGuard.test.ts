// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { installDesktopContextMenuGuard } from './installDesktopContextMenuGuard';

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

let stop: (() => void) | null = null;

afterEach(() => {
  stop?.();
  stop = null;
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = '';
  platformState.isMac = true;
});

function mount(html: string, selector: string): Element {
  document.body.innerHTML = html;
  return document.querySelector(selector)!;
}

function contextMenu(target: EventTarget): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('the WebKit context menu', () => {
  // The editor is sacred: spellcheck suggestions, Look Up and Cut/Copy/Paste
  // all live in the native menu the editor must keep.
  it.each([
    ['plain chrome', true, '<button>New</button>', 'button'],
    [
      'the editor',
      false,
      '<div class="ProseMirror" contenteditable="true"><p><span>hi</span></p></div>',
      'span',
    ],
    ['a textarea', false, '<textarea></textarea>', 'textarea'],
    ['a text input', false, '<input type="text" />', 'input'],
    ['a contenteditable', false, '<div contenteditable="true"></div>', 'div'],
  ])('on %s is suppressed: %s', (_where, suppressed, html, selector) => {
    stop = installDesktopContextMenuGuard();
    expect(contextMenu(mount(html, selector))).toBe(suppressed);
  });

  it('is kept when there is a live selection to act on', () => {
    stop = installDesktopContextMenuGuard();
    const preview = mount('<p>note preview</p>', 'p');
    const range = document.createRange();
    range.selectNodeContents(preview);
    window.getSelection()!.addRange(range);

    expect(contextMenu(preview)).toBe(false);
  });
});

describe('macOS control-click never reaches the app as a click', () => {
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

  // Two control-clicks arrive as a dblclick, which would open inline rename;
  // off macOS Ctrl+click opens a background tab and must reach the app.
  it.each([
    ['swallows a control-click on macOS', true, 'click', true, 0],
    ['swallows a control-dblclick on macOS', true, 'dblclick', true, 0],
    ['leaves a plain click alone', true, 'click', false, 1],
    ['leaves Ctrl+click alone off macOS', false, 'click', true, 1],
  ] as const)('%s', (_title, isMac, type, ctrlKey, delivered) => {
    platformState.isMac = isMac;
    stop = installDesktopContextMenuGuard();
    const { el, clicks } = row();

    dispatch(el, type, ctrlKey);
    expect(clicks).toHaveBeenCalledTimes(delivered);
  });

  it('stops swallowing once uninstalled', () => {
    installDesktopContextMenuGuard()();
    const { el, clicks } = row();

    dispatch(el, 'click', true);
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
