// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

import LanguageSettingsSection from './LanguageSettingsSection.svelte';

describe('LanguageSettingsSection dropdown dismissal', () => {
  let target: HTMLDivElement;
  let outsideButton: HTMLButtonElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    outsideButton = document.createElement('button');
    document.body.append(target, outsideButton);
    app = mount(LanguageSettingsSection, {
      target,
      props: {
        selectedLanguageTag: null,
        languages: [{ tag: 'zh-Hans', nativeName: '简体中文', direction: 'ltr' }],
        onchange: vi.fn(),
      },
    });
    flushSync();
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    outsideButton.remove();
  });

  function trigger(): HTMLButtonElement {
    return target.querySelector<HTMLButtonElement>('.settings-language-trigger')!;
  }

  function listbox(): HTMLElement | null {
    return target.querySelector<HTMLElement>('#settings-language-options');
  }

  function press(element: Element): boolean {
    const defaultAllowed = element.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    flushSync();
    return defaultAllowed;
  }

  async function open(): Promise<void> {
    press(trigger());
    trigger().click();
    flushSync();
    await tick();
    expect(listbox()).not.toBeNull();
    expect(listbox()!.contains(document.activeElement)).toBe(true);
  }

  it('closes once when the trigger is clicked while open, without letting the press move focus', async () => {
    await open();
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    trigger().dispatchEvent(mousedown);
    expect(mousedown.defaultPrevented).toBe(true);
    expect(listbox()).not.toBeNull();

    trigger().click();
    flushSync();
    expect(listbox()).toBeNull();
    await tick();
    expect(document.activeElement).toBe(trigger());
  });

  it('closes on a pointer press outside the picker without stealing focus', async () => {
    await open();
    press(outsideButton);
    expect(listbox()).toBeNull();
    await tick();
    expect(document.activeElement).not.toBe(trigger());
  });

  it('closes when focus lands outside the picker', async () => {
    await open();
    outsideButton.focus();
    flushSync();
    expect(listbox()).toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    await open();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    flushSync();
    await tick();
    expect(listbox()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
