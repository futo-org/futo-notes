// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

import AppearanceSettingsSection from './AppearanceSettingsSection.svelte';

describe('AppearanceSettingsSection', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) unmount(app);
    target.remove();
  });

  function render(showLinuxDesktopOptions: boolean) {
    const onfollowaccentchange = vi.fn();
    app = mount(AppearanceSettingsSection, {
      target,
      props: {
        preference: 'auto',
        followSystemAccent: true,
        showLinuxDesktopOptions,
        onchange: vi.fn(),
        onfollowaccentchange,
      },
    });
    return { onfollowaccentchange };
  }

  it('shows the persisted Linux accent control without a font changer', () => {
    const callbacks = render(true);

    const accent = target.querySelector(
      'button[aria-pressed="true"] .settings-btn-label',
    ) as HTMLElement;
    expect(accent.textContent).toBe('Follow system accent color');
    accent.closest('button')?.click();
    expect(callbacks.onfollowaccentchange).toHaveBeenCalledOnce();
    expect(target.textContent).not.toContain('Interface font');
  });

  it('keeps Linux-only controls out of browser and native-mobile surfaces', () => {
    render(false);

    expect(target.textContent).not.toContain('Follow system accent color');
  });
});
