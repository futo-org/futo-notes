// Pictures in desktop editor stories: a small PNG, the vault references a note's text holds,
// waiting for saved pictures to land, and deleting the vault files a story made.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { devVault, inScratchNote, read, until, untilIdle } from './desktop-editor-story.mjs';

/** A 40×30 orange PNG, base64. */
export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAKUlEQVR42u3NMQ0AAAgDsPkPnpkMOJr0b3Zy' +
  'ImKxWCwWi8VisVgs/hsXBQ87+lkXKkEAAAAASUVORK5CYII=';

export const VAULT = devVault();
const REFERENCE = /!\[\]\((image-[^)]+)\)/g;

const fileText = (noteId) =>
  read('file', { noteId, save: false })
    .lines.map((line) => line.text)
    .join('\n');

/** The vault images a note's text refers to. */
export const referencesIn = (text) => [...text.matchAll(REFERENCE)].map((match) => match[1]);

/** `run(noteId, keep)` in a scratch note, then the vault images `keep` saw are deleted. */
export function withPictures(run) {
  return inScratchNote(async (noteId) => {
    const made = new Set();
    try {
      await run(noteId, (text) => {
        for (const reference of referencesIn(text)) made.add(reference);
        return text;
      });
    } finally {
      for (const reference of made) rmSync(join(VAULT, reference), { force: true });
    }
  });
}

/** The note's text once `count` pictures have landed in it (a file saves first). */
export async function untilPictures(noteId, count, keep) {
  await until(
    () => referencesIn(fileText(noteId)).length === count,
    `${count} picture(s) written`,
    5000,
  );
  await untilIdle();
  return keep(fileText(noteId));
}
