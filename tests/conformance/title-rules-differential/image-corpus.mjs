/**
 * Probe inputs for the image family (image.json).
 */

import { IMAGE_EXTENSIONS } from '../../../packages/editor/src/images.ts';
import { PARTY, sample, unique, xorshift32 } from './seeded-random-and-charsets.mjs';

// --- Family: image (image.json) --------------------------------------------

export function imageFilenameCorpus() {
  const filenames = [];
  for (const extension of IMAGE_EXTENSIONS) {
    filenames.push(
      `photo.${extension}`,
      `photo.${extension.toUpperCase()}`,
      `photo.${extension[0].toUpperCase()}${extension.slice(1)}`,
      `photo.${extension} `,
      `photo.${extension}\n`,
      `photo.x.${extension}`,
      `photo.${extension}.md`,
      `.${extension}`,
      `${extension}`,
      `photo.${extension}${extension}`,
    );
  }
  filenames.push(
    'note.md',
    'file.txt',
    'script.js',
    'archive.zip',
    'scan.tiff',
    'scan.tif',
    'photo.heif',
    'noextension',
    '.hidden',
    '',
    '.',
    '..',
    'trailing.',
    'a..png',
    'a.PNG.',
    '1742345678901-xk7.png',
    'ünïcode.PNG',
    `${PARTY}.jpg`,
    // Case-mapping traps in the extension slot: only a plain Unicode lowercase can
    // match, so the ligature / dotted-I / long-s / Kelvin forms must all miss.
    'photo.ſVG',
    'photo.K',
    'photo.İCO',
    'photo.ıco',
    'photo.ICO',
    `photo.${'x'.repeat(300)}`,
    'photo/with.png',
    'photo\\with.png',
  );
  const alphabet = ['a', 'P', 'N', 'G', '.', 'j', 'p', 'g', '/', ' ', 'É', PARTY];
  const rng = xorshift32(0x1a6e1701);
  for (let index = 0; index < 200; index += 1) filenames.push(sample(rng, alphabet, rng() % 13));
  return unique(filenames);
}
