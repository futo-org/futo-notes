// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import CreateFolderModal from './CreateFolderModal.svelte';
import { validateNewFolderName } from './folderOperations';

describe('CreateFolderModal live validation', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) {
      unmount(app);
      app = null;
    }
    target.remove();
  });

  const input = () =>
    document.querySelector('[data-testid="create-folder-input"]') as HTMLInputElement;
  const confirmBtn = () =>
    document.querySelector('[data-testid="create-folder-confirm"]') as HTMLButtonElement;
  const errorEl = () => document.querySelector('.modal-error');

  function type(value: string): void {
    const el = input();
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  }

  function mountModal(onsubmit: (v: string) => string | null = () => null) {
    app = mount(CreateFolderModal, {
      target,
      props: {
        onsubmit,
        validate: (v: string) => validateNewFolderName('', v.trim(), ['Existing']),
        oncancel: () => {},
      },
    });
    flushSync();
  }

  it('disables Create and shows the error live for a case-insensitive duplicate', () => {
    mountModal();
    type('existing');
    expect(confirmBtn().disabled).toBe(true);
    expect(errorEl()?.textContent).toBe('A folder with this name already exists');
  });

  it('re-enables Create and clears the error once the name is unique', () => {
    mountModal();
    type('existing');
    expect(confirmBtn().disabled).toBe(true);
    type('fresh');
    expect(confirmBtn().disabled).toBe(false);
    expect(errorEl()).toBeNull();
  });

  it('disables Create for an empty name without scolding with an error', () => {
    mountModal();
    expect(input().value).toBe('');
    expect(confirmBtn().disabled).toBe(true);
    expect(errorEl()).toBeNull();
    type('   ');
    expect(confirmBtn().disabled).toBe(true);
    expect(errorEl()).toBeNull();
  });

  it('blocks Enter-key submit while invalid (backstop)', () => {
    const onsubmit = vi.fn(() => null);
    mountModal(onsubmit);
    type('EXISTING');
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onsubmit).not.toHaveBeenCalled();

    type('unique-name');
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onsubmit).toHaveBeenCalledWith('unique-name');
  });
});
