// @vitest-environment jsdom
/* The `/` menu on the real engine: what it lists, its keys, and each item's saved result. */
import { afterEach, expect, it, vi } from 'vitest';
import { registeredVerbs, type PuppetOutcome } from '$app/puppet/puppetRegistry';
import { mountView, type MountedView } from './__test__/mountView';

const { vault } = vi.hoisted(() => ({
  vault: {
    saveImageBytes: async (): Promise<string> => 'image-1.png',
    getImageUrl: async (filename: string): Promise<string> => `asset://${filename}`,
    pickImages: vi.fn(async () => [{ bytes: new ArrayBuffer(4), extension: 'png' }]),
  },
}));
vi.mock('$lib/platform', () => ({
  getFS: () => vault,
  getPlatformFS: async () => vault,
  onFileDrop: () => () => {},
}));

/** Every view a test mounted: each registers its menu's Puppet verb until destroyed. */
const mountedViews: MountedView[] = [];

afterEach(() => {
  for (const mounted of mountedViews.splice(0)) mounted.view.destroy();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** A view showing `source`, the caret at its end, the menu read. */
async function typed(source: string): Promise<MountedView> {
  const mounted = await mountView(source);
  mountedViews.push(mounted);
  // jsdom lays nothing out: the caret has no box to put the list under.
  vi.spyOn(mounted.view.caretSide, 'clientRect').mockReturnValue(new DOMRect(10, 10, 0, 16));
  mounted.view.selection.selectRange(source.length, source.length);
  mounted.view.slashMenu.update();
  return mounted;
}

const rows = (): string[] =>
  [...document.querySelectorAll('.desktop-slash-menu-label')].map((row) => row.textContent ?? '');
const selectedRow = (): string | null | undefined =>
  document.querySelector('.desktop-slash-menu [aria-selected="true"] .desktop-slash-menu-label')
    ?.textContent;
const press = (mounted: MountedView, key: string): boolean =>
  mounted.view.slashMenu.keyDown(new KeyboardEvent('keydown', { key, cancelable: true }));

it('lists every item it has a command for, and narrows by the query', async () => {
  await typed('/');
  expect(rows()).toEqual([
    'Text',
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Bullet list',
    'Numbered list',
    'Task list',
    'Quote',
    'Code block',
    'Divider',
    'Table',
    'Link',
    'Image',
  ]);
  document.body.replaceChildren();
  await typed('/head');
  expect(rows()).toEqual(['Heading 1', 'Heading 2', 'Heading 3']);
});

it('hides for a query nothing matches, and outside a run', async () => {
  await typed('/zzzz');
  expect(rows()).toEqual([]);
  await typed('and/');
  expect(rows()).toEqual([]);
});

it('moves with the arrows, wrapping, and Enter picks the highlighted item', async () => {
  const mounted = await typed('/head');
  expect(selectedRow()).toBe('Heading 1');
  expect(press(mounted, 'ArrowDown')).toBe(true);
  expect(selectedRow()).toBe('Heading 2');
  press(mounted, 'ArrowUp');
  press(mounted, 'ArrowUp');
  expect(selectedRow()).toBe('Heading 3');
  expect(press(mounted, 'Enter')).toBe(true);
  expect(mounted.engine.draftText()).toBe('### ');
  expect(rows()).toEqual([]);
});

it('takes Tab as Enter, and a press on a row picks it', async () => {
  const tabbed = await typed('/quo');
  press(tabbed, 'Tab');
  expect(tabbed.engine.draftText()).toBe('> ');
  document.body.replaceChildren();
  const pressed = await typed('/');
  const divider = [...document.querySelectorAll('.desktop-slash-menu li')][9];
  divider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  expect(pressed.engine.draftText()).toBe('---\n');
});

it('Escape closes it and keeps the typed text while that `/` stays', async () => {
  const mounted = await typed('/hea');
  expect(press(mounted, 'Escape')).toBe(true);
  expect(rows()).toEqual([]);
  mounted.view.run((engine) => engine.replace({ start: 4, end: 4 }, 'd', 'Typing'));
  mounted.view.slashMenu.update();
  expect(rows()).toEqual([]);
  expect(mounted.engine.draftText()).toBe('/head');
});

it('each item replaces the typed query with its block, one Undo bringing the query back', async () => {
  const results: Record<string, string> = {
    Text: '',
    'Heading 1': '# ',
    'Bullet list': '- ',
    'Numbered list': '1. ',
    'Task list': '- [ ] ',
    'Code block': '```\n\n```',
    Divider: '---\n',
    Table: '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |',
  };
  for (const [label, saved] of Object.entries(results)) {
    document.body.replaceChildren();
    const mounted = await typed('/');
    const row = [...document.querySelectorAll('.desktop-slash-menu li')].find(
      (one) => one.querySelector('.desktop-slash-menu-label')?.textContent === label,
    )!;
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect(mounted.engine.draftText(), label).toBe(saved);
    mounted.view.run((engine) => engine.undo());
    expect(mounted.engine.draftText(), label).toBe('/');
    mounted.engine.free();
  }
});

it('Link removes the query and opens the Link prompt at the caret', async () => {
  const mounted = await typed('/link');
  // jsdom has no editable content, which the prompt needs to open.
  const opened = vi.spyOn(mounted.view.linkPrompt, 'open').mockImplementation(() => {});
  press(mounted, 'Enter');
  expect(mounted.engine.draftText()).toBe('');
  expect(opened).toHaveBeenCalledOnce();
});

it('Image removes the query and opens the image picker at the caret', async () => {
  const mounted = await typed('/image');
  const picked = vi.spyOn(mounted.view.imageInput, 'pick').mockImplementation(() => {});
  press(mounted, 'Enter');
  expect(mounted.engine.draftText()).toBe('');
  expect(picked).toHaveBeenCalledOnce();
});

it("Puppet's PickSlashItem answers Image's picker with `path`, and is refused without one", async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const mounted = await typed('/image');
  const pickSlashItem = (args: Record<string, unknown>): PuppetOutcome =>
    registeredVerbs()
      .find((verb) => verb.name === 'PickSlashItem')!
      .run(args) as PuppetOutcome;
  expect(pickSlashItem({ item: 'image' }).status).toBe(400);
  expect(mounted.engine.draftText()).toBe('/image');
  pickSlashItem({ item: 'image', path: '/home/me/photo.png' });
  await vi.waitFor(() => expect(mounted.engine.draftText()).toBe('![](image-1.png)'));
  expect(vault.pickImages).toHaveBeenCalledWith(
    expect.objectContaining({ paths: ['/home/me/photo.png'] }),
  );
});
