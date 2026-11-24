/* Where a pressed link goes (linkTarget.ts), on the engine's reading of its destination. */
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { opensBehind, resolvePressedLink } from './linkTarget';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

async function inVault(): Promise<Engine> {
  const engine = await Engine.restore({ token: 1, source: '', revision: 0, paused: false });
  engine.updateNoteIds(['Projects/Roadmap', 'Projects/Notes/plan', 'another note']);
  return engine;
}

const link = (destination: string) => ({ kind: 'link' as const, destination });

it('a destination naming a note opens that note, from the open note’s folder', async () => {
  const engine = await inVault();
  expect(resolvePressedLink(engine, 'Projects/Notes/plan', link('../Roadmap.md'))).toEqual({
    kind: 'note',
    noteId: 'Projects/Roadmap',
  });
  expect(resolvePressedLink(engine, 'Projects/Roadmap', link('/another%20note'))).toEqual({
    kind: 'note',
    noteId: 'another note',
  });
  engine.free();
});

it('a web address opens outside the app; a note path no note holds and other schemes go nowhere', async () => {
  const engine = await inVault();
  expect(resolvePressedLink(engine, 'another note', link('https://x.test/a'))).toEqual({
    kind: 'external',
    url: 'https://x.test/a',
  });
  expect(resolvePressedLink(engine, 'another note', link('missing note'))).toBeNull();
  expect(resolvePressedLink(engine, 'another note', link('javascript:alert(1)'))).toBeNull();
  engine.free();
});

it('Mod+click and a middle click ask for a web address behind the window', () => {
  const plain = { button: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  expect(opensBehind(plain, true)).toBe(false);
  expect(opensBehind({ ...plain, metaKey: true }, true)).toBe(true);
  expect(opensBehind({ ...plain, metaKey: true }, false)).toBe(false);
  expect(opensBehind({ ...plain, ctrlKey: true }, false)).toBe(true);
  expect(opensBehind({ ...plain, button: 1 }, false)).toBe(true);
});

it('a wikilink opens the note it resolves to, else its target as written', async () => {
  const engine = await inVault();
  const wikilink = { kind: 'wikilink' as const, noteId: null, target: 'New idea' };
  expect(resolvePressedLink(engine, 'another note', wikilink)).toEqual({
    kind: 'note',
    noteId: 'New idea',
  });
  engine.free();
});

it('the Link prompt saves a schemeless web address with https and a note path as typed', async () => {
  const engine = await inVault();
  expect(engine.normalizeLinkDestination('another note', 'example.com')).toBe(
    'https://example.com',
  );
  expect(engine.normalizeLinkDestination('another note', 'Projects/Roadmap')).toBe(
    'Projects/Roadmap',
  );
  expect(engine.normalizeLinkDestination('another note', 'setup.sh')).toBe('setup.sh');
  expect(engine.normalizeLinkDestination('another note', '')).toBe('');
  engine.free();
});
