// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, type Component } from 'svelte';

import type { VaultStatus } from '$lib/platform/tauri';
import { desktopLocalization } from '$shared/localization';

const availability = vi.hoisted(() => ({
  status: null as VaultStatus | null,
  get unavailable() {
    return this.status?.available === false;
  },
}));
const chooseNotesDirectory = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./vaultAvailability.svelte', () => ({ vaultAvailability: availability }));
vi.mock('./notesDirectory', () => ({ chooseNotesDirectory }));

import VaultUnavailableBanner from './VaultUnavailableBanner.svelte';
import SidebarCreateActions from '$features/sidebar/components/SidebarCreateActions.svelte';
import NoteTagBar from '$features/editor/NoteTagBar.svelte';

const status = (overrides: Partial<VaultStatus>): VaultStatus => ({
  displayPath: 'C:\\Users\\Admin\\Documents\\futo-notes',
  isCustom: false,
  available: true,
  accessRefused: false,
  deletesArePermanent: false,
  folderDeletesArePermanent: false,
  ...overrides,
});

describe('unusable vault UI', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  function render<Props extends Record<string, unknown>>(
    component: Component<Props>,
    props = {} as Props,
  ): HTMLElement {
    app = mount(component, { target, props });
    flushSync();
    return target;
  }

  beforeEach(() => {
    desktopLocalization.setSelectedLanguageTag('en');
    availability.status = null;
    chooseNotesDirectory.mockClear();
    target = document.createElement('div');
    document.body.appendChild(target);
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    desktopLocalization.setSelectedLanguageTag(null);
  });

  it('shows no banner for a usable vault or before the status lands', () => {
    expect(render(VaultUnavailableBanner).textContent?.trim()).toBe('');
    unmount(app!);
    availability.status = status({ available: true });
    expect(render(VaultUnavailableBanner).textContent?.trim()).toBe('');
  });

  // Crash 1739: Controlled Folder Access refused the default folder and the app
  // opened empty with nothing on screen saying why.
  it('names the default folder it is not allowed to create', () => {
    availability.status = status({ available: false });
    expect(render(VaultUnavailableBanner).querySelector('[role="alert"]')?.textContent).toMatch(
      "FUTO Notes can't save anything. It isn't allowed to create its notes folder at C:\\Users\\Admin\\Documents\\futo-notes.",
    );
  });

  it('names the custom folder that has gone missing', () => {
    availability.status = status({
      available: false,
      isCustom: true,
      displayPath: '/mnt/usb/notes',
    });
    expect(render(VaultUnavailableBanner).textContent).toMatch(
      "FUTO Notes can't save anything. It can't find your notes folder at /mnt/usb/notes.",
    );
  });

  it('names the folder that refuses changes', () => {
    availability.status = status({ available: false, accessRefused: true });
    expect(render(VaultUnavailableBanner).textContent).toMatch(
      "FUTO Notes can't save anything. It isn't allowed to change your notes folder at C:\\Users\\Admin\\Documents\\futo-notes.",
    );
  });

  it('offers the folder picker as the way out', () => {
    availability.status = status({ available: false });
    render(VaultUnavailableBanner).querySelector('button')!.click();
    expect(chooseNotesDirectory).toHaveBeenCalledOnce();
  });

  it('disables New note and New folder while nothing can be saved', () => {
    const props = { onclicknewnote: vi.fn(), onclicknewfolder: vi.fn() };
    availability.status = status({ available: false });
    const buttons = [...render(SidebarCreateActions, props).querySelectorAll('button')];
    expect(buttons.map((button) => button.disabled)).toEqual([true, true]);
  });

  it('keeps New note and New folder enabled for a usable vault', () => {
    const props = { onclicknewnote: vi.fn(), onclicknewfolder: vi.fn() };
    availability.status = status({ available: true });
    const buttons = [...render(SidebarCreateActions, props).querySelectorAll('button')];
    expect(buttons.map((button) => button.disabled)).toEqual([false, false]);
  });

  it('shows tags without add or remove controls while read-only', () => {
    const props = {
      content: '#work #home\n\nBody',
      readMarkdown: () => undefined,
      writeMarkdown: vi.fn(),
      notes: [],
      readonly: true,
    };
    const bar = render(NoteTagBar, props);
    expect(bar.querySelectorAll('.tag-pill')).toHaveLength(2);
    expect(bar.querySelector('button')).toBeNull();
  });
});
