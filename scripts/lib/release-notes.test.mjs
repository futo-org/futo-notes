import { describe, expect, it } from 'vitest';

import {
  APP_STORE_LIMIT,
  PLAY_LIMIT,
  parseReleaseNotes,
  releaseNotesPath,
  validateReleaseNotes,
} from './release-notes.mjs';

const withShort = `# v1.7.2

Folders now sync to Windows correctly.

- Faster opening of large notes.

## Short

Fixes folder sync on Windows and opens large notes faster.
`;

describe('parseReleaseNotes', () => {
  it('splits the App Store body from the Play body and drops the title', () => {
    const notes = parseReleaseNotes(withShort);
    expect(notes.appStore).toBe(
      'Folders now sync to Windows correctly.\n\n- Faster opening of large notes.',
    );
    expect(notes.play).toBe('Fixes folder sync on Windows and opens large notes faster.');
    expect(notes.hasShort).toBe(true);
  });

  it('uses the whole body for both stores when there is no Short section', () => {
    const notes = parseReleaseNotes('# v1.0.0\n\nFirst release.\n');
    expect(notes.appStore).toBe('First release.');
    expect(notes.play).toBe('First release.');
    expect(notes.hasShort).toBe(false);
  });

  it('keeps a body that has no title line', () => {
    expect(parseReleaseNotes('Just the notes.\n').appStore).toBe('Just the notes.');
  });

  it('does not mistake a deeper heading named Short for the separator', () => {
    const notes = parseReleaseNotes('# v1.0.0\n\nBody.\n\n### Short\n\nNot a separator.\n');
    expect(notes.hasShort).toBe(false);
    expect(notes.appStore).toContain('### Short');
  });

  it('keeps Markdown headings inside the App Store body intact', () => {
    const notes = parseReleaseNotes('# v1.0.0\n\n## Fixed\n\nA bug.\n\n## Short\n\nFixed a bug.\n');
    expect(notes.appStore).toBe('## Fixed\n\nA bug.');
    expect(notes.play).toBe('Fixed a bug.');
  });
});

describe('validateReleaseNotes', () => {
  it('accepts a well-formed file', () => {
    expect(validateReleaseNotes(parseReleaseNotes(withShort), { tag: 'v1.7.2' })).toEqual([]);
  });

  it('rejects an empty file', () => {
    const problems = validateReleaseNotes(parseReleaseNotes('# v1.0.0\n'), { tag: 'v1.0.0' });
    expect(problems.join('\n')).toContain('release-notes/v1.0.0.md has no App Store text');
  });

  it('rejects an App Store body over the 4000-character limit', () => {
    const notes = parseReleaseNotes(
      `# v1.0.0\n\n${'x'.repeat(APP_STORE_LIMIT + 1)}\n\n## Short\n\nok\n`,
    );
    const problems = validateReleaseNotes(notes, { tag: 'v1.0.0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(`at most ${APP_STORE_LIMIT}`);
  });

  it('rejects a long body with no Short section and says to add one', () => {
    const notes = parseReleaseNotes(`# v1.0.0\n\n${'x'.repeat(PLAY_LIMIT + 1)}\n`);
    const problems = validateReleaseNotes(notes, { tag: 'v1.0.0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('add a `## Short` section');
  });

  it('rejects a Short section that is itself too long and says to shorten it', () => {
    const notes = parseReleaseNotes(
      `# v1.0.0\n\nFine.\n\n## Short\n\n${'x'.repeat(PLAY_LIMIT + 1)}\n`,
    );
    const problems = validateReleaseNotes(notes, { tag: 'v1.0.0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('shorten the `## Short` section');
  });

  it('reports every problem at once rather than one per run', () => {
    const notes = parseReleaseNotes(
      `# v1.0.0\n\n${'x'.repeat(APP_STORE_LIMIT + 1)}\n\n## Short\n\n${'y'.repeat(PLAY_LIMIT + 1)}\n`,
    );
    expect(validateReleaseNotes(notes, { tag: 'v1.0.0' })).toHaveLength(2);
  });

  it('accepts text exactly at both limits', () => {
    const notes = parseReleaseNotes(
      `# v1.0.0\n\n${'x'.repeat(APP_STORE_LIMIT)}\n\n## Short\n\n${'y'.repeat(PLAY_LIMIT)}\n`,
    );
    expect(validateReleaseNotes(notes, { tag: 'v1.0.0' })).toEqual([]);
  });
});

describe('releaseNotesPath', () => {
  it('names the file after the tag', () => {
    expect(releaseNotesPath('v1.7.2')).toBe('release-notes/v1.7.2.md');
  });
});
