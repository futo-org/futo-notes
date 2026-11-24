// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { pictureOf } from './pictureElements';
import type { ImageUrls } from './pictureLoading';
import { mountImageNote, type ImageNote } from './__test__/mountImageNote';

let note: ImageNote | null = null;
afterEach(() => {
  note?.close();
  note = null;
});

type Listener = () => void;

/** A shell resolving vault files by request, as desktop's `getImageUrl` does. */
function vaultUrls(found = true): ImageUrls & { requested: string[]; land(name: string): void } {
  const known = new Map<string, string>();
  const listeners = new Set<Listener>();
  const requested: string[] = [];
  return {
    requested,
    resolve: (destination) =>
      /^(https?|data):/.test(destination) ? destination : (known.get(destination) ?? ''),
    request: (destination) => {
      requested.push(destination);
      return Promise.resolve(found);
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    land(name) {
      known.set(name, `asset://localhost/vault/${name}`);
      listeners.forEach((listener) => listener());
    },
  };
}

const drawn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
const pictures = (note: ImageNote): HTMLImageElement[] =>
  [...note.view.dom.querySelectorAll('.atom.image')].map((image) => pictureOf(image)!);

it('resolves and loads a picture only once it comes near the pane', async () => {
  const urls = vaultUrls();
  note = await mountImageNote('![](a.png)\n![](https://example.com/b.png)', urls);
  await drawn();
  expect(urls.requested).toEqual([]);
  note.bringNear();
  const [vault, remote] = pictures(note);
  expect(urls.requested).toEqual(['a.png']);
  expect(vault.hasAttribute('src')).toBe(false);
  expect(remote.getAttribute('src')).toBe('https://example.com/b.png');
  urls.land('a.png');
  expect(vault.getAttribute('src')).toBe('asset://localhost/vault/a.png');
});

it('marks a picture that will not load, and clears the mark when it does', async () => {
  const urls = vaultUrls();
  urls.land('gone.png');
  note = await mountImageNote('![](gone.png)', urls);
  await drawn();
  note.bringNear();
  const [picture] = pictures(note);
  picture.dispatchEvent(new Event('error'));
  expect(picture.parentElement!.hasAttribute('data-missing')).toBe(true);
  picture.dispatchEvent(new Event('load'));
  expect(picture.parentElement!.hasAttribute('data-missing')).toBe(false);
});

it('marks a picture whose file the shell cannot find', async () => {
  const urls = vaultUrls(false);
  note = await mountImageNote('![](not-synced-yet.png)', urls);
  await drawn();
  note.bringNear();
  await drawn();
  const [picture] = pictures(note);
  expect(picture.parentElement!.hasAttribute('data-missing')).toBe(true);
  urls.land('not-synced-yet.png');
  expect(picture.getAttribute('src')).toBe('asset://localhost/vault/not-synced-yet.png');
});

it('watches a picture drawn by an edit, and forgets one deleted', async () => {
  const urls = vaultUrls();
  note = await mountImageNote('x', urls);
  note.view.selection.selectRange(1, 1);
  note.view.insert('![](c.png)');
  await drawn();
  note.bringNear();
  expect(urls.requested).toEqual(['c.png']);
  note.view.run((engine) => engine.undo());
  await drawn();
  urls.requested.length = 0;
  note.bringNear();
  expect(urls.requested).toEqual([]);
});
