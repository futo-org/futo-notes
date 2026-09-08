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

  it('offers the theme choice alone — no accent follower and no font changer', () => {
    const onchange = vi.fn();
    app = mount(AppearanceSettingsSection, { target, props: { preference: 'auto', onchange } });

    expect([...target.querySelectorAll('.settings-segment')].map((b) => b.textContent)).toEqual([
      'Auto',
      'Dark',
      'Light',
    ]);
    expect(target.textContent).not.toContain('Follow system accent color');
    expect(target.textContent).not.toContain('Interface font');
  });
});
