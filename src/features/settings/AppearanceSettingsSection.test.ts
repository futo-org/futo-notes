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
    const oninterfacefontchange = vi.fn();
    app = mount(AppearanceSettingsSection, {
      target,
      props: {
        preference: 'auto',
        followSystemAccent: true,
        interfaceFont: 'system',
        showLinuxDesktopOptions,
        onchange: vi.fn(),
        onfollowaccentchange,
        oninterfacefontchange,
      },
    });
    return { onfollowaccentchange, oninterfacefontchange };
  }

  it('shows the persisted Linux accent and interface-font controls', () => {
    const callbacks = render(true);

    const accent = target.querySelector(
      'button[aria-pressed="true"] .settings-btn-label',
    ) as HTMLElement;
    expect(accent.textContent).toBe('Follow system accent color');
    accent.closest('button')?.click();
    expect(callbacks.onfollowaccentchange).toHaveBeenCalledOnce();

    const barlow = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent === 'Barlow',
    );
    barlow?.click();
    expect(callbacks.oninterfacefontchange).toHaveBeenCalledWith('barlow');
  });

  it('keeps Linux-only controls out of browser and native-mobile surfaces', () => {
    render(false);

    expect(target.textContent).not.toContain('Follow system accent color');
    expect(target.textContent).not.toContain('Interface font');
  });
});
