/**
 * Microbenchmarks for the hot paths driven on every keystroke and save.
 * Skipped by default to keep `pnpm run test:unit` fast; run with:
 *
 *     PERF_BENCH=1 pnpm exec vitest run src/lib/perf.bench.test.ts
 *
 * The numbers are wall-clock micros per call. Compare relative changes
 * across commits; absolute values vary by hardware.
 */
import { describe, it } from 'vitest';
import type { NotePreview } from '../types';
import { getSortedTags, getNotesForTag, buildTagIndex } from './tags';
import { getForYouNotes } from './forYou';
import { extractHeaderTagBlock, TAG_REGEX } from '$lib/rules';

// Old extractHeaderTagBlock kept inline as a baseline.
function extractHeaderTagBlock_old(content: string): { tags: string[]; endOffset: number } {
  const TAG_LINE_RE = /^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$/;
  const lines = content.split('\n');
  const tags: string[] = [];
  const seen = new Set<string>();
  let endLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TAG_LINE_RE.test(line)) {
      const re = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const tag = '#' + match[1].toLowerCase();
        if (!seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
        }
      }
      endLine = i + 1;
    } else {
      break;
    }
  }
  if (endLine === 0) return { tags: [], endOffset: 0 };
  let offset = 0;
  for (let i = 0; i < endLine; i++) offset += lines[i].length + 1;
  if (endLine < lines.length && lines[endLine].trim() === '') {
    offset += lines[endLine].length + 1;
  }
  if (offset > content.length) offset = content.length;
  return { tags, endOffset: offset };
}

// Old implementation, retained as a baseline for the forYou bench.
function getForYouNotes_old(notes: NotePreview[], limit = 3): NotePreview[] {
  if (notes.length === 0) return [];
  return [...notes].sort((a, b) => b.modificationTime - a.modificationTime).slice(0, limit);
}

const RUN = process.env.PERF_BENCH === '1';

function makeNotes(n: number, avgTags = 4): NotePreview[] {
  const TAG_POOL = [
    'work',
    'home',
    'todo',
    'idea',
    'reading',
    'tech',
    'rust',
    'svelte',
    'cooking',
    'travel',
    'meeting',
    'project',
    'urgent',
    'someday',
    'review',
    'q1',
    'q2',
    'q3',
    'q4',
    'inbox',
  ];
  const notes: NotePreview[] = [];
  for (let i = 0; i < n; i++) {
    const tags: string[] = [];
    for (let t = 0; t < avgTags; t++) {
      tags.push(TAG_POOL[(i * 7 + t * 3) % TAG_POOL.length]);
    }
    notes.push({
      id: `note-${i.toString().padStart(5, '0')}`,
      title: `Note ${i}`,
      preview: '',
      modificationTime: Date.now() - i * 1000,
      tags,
    });
  }
  return notes;
}

function bench(label: string, iters: number, fn: () => unknown): void {
  // Warmup
  for (let i = 0; i < Math.max(1, iters / 10); i++) fn();
  const start = performance.now();
  let sink = 0;
  for (let i = 0; i < iters; i++) {
    const r = fn();
    if (Array.isArray(r)) sink += r.length;
  }
  const elapsed = performance.now() - start;
  console.log(
    `${label.padEnd(40)} ${iters} iters in ${elapsed.toFixed(2)}ms ` +
      `(${((elapsed * 1000) / iters).toFixed(2)}µs/op) sink=${sink}`,
  );
}

describe.skipIf(!RUN)('perf bench: tag operations', () => {
  it('getSortedTags @ 100 notes', () => {
    const notes = makeNotes(100);
    bench('getSortedTags(100)', 5_000, () => getSortedTags(notes));
  });

  it('getSortedTags @ 1000 notes', () => {
    const notes = makeNotes(1000);
    bench('getSortedTags(1000)', 1_000, () => getSortedTags(notes));
  });

  it('getNotesForTag @ 1000 notes', () => {
    const notes = makeNotes(1000);
    bench('getNotesForTag(1000)', 5_000, () => getNotesForTag(notes, 'work'));
  });

  it('buildTagIndex @ 1000 notes', () => {
    const notes = makeNotes(1000);
    bench('buildTagIndex(1000)', 1_000, () => buildTagIndex(notes));
  });

  it('ID set signature @ 1000 notes (NotesShell effect gate)', () => {
    const notes = makeNotes(1000);
    bench('idSignature(1000)', 1_000, () => {
      return notes
        .map((n) => n.id)
        .sort()
        .join('\n');
    });
  });
});

describe.skipIf(!RUN)('perf bench: extractHeaderTagBlock', () => {
  it('small note (1KB body, 2 header tags)', () => {
    const content = '#work #project\n\n' + 'lorem ipsum dolor sit amet '.repeat(40);
    bench('header_old(1KB)         ', 10_000, () => extractHeaderTagBlock_old(content));
    bench('header_new(1KB)         ', 10_000, () => extractHeaderTagBlock(content));
  });

  it('large note (32KB body, 2 header tags)', () => {
    const content = '#work #project\n\n' + 'lorem ipsum dolor sit amet '.repeat(1200);
    bench('header_old(32KB)        ', 1_000, () => extractHeaderTagBlock_old(content));
    bench('header_new(32KB)        ', 1_000, () => extractHeaderTagBlock(content));
  });

  it('large note (128KB body, no header tags)', () => {
    const content = 'lorem ipsum dolor sit amet '.repeat(5000);
    bench('header_old(128KB,noTag) ', 1_000, () => extractHeaderTagBlock_old(content));
    bench('header_new(128KB,noTag) ', 1_000, () => extractHeaderTagBlock(content));
  });
});

describe.skipIf(!RUN)('perf bench: forYou', () => {
  it('getForYouNotes vs old @ 1000 notes', () => {
    const notes = makeNotes(1000);
    bench('getForYouNotes_old(1000)', 5_000, () => getForYouNotes_old(notes, 3));
    bench('getForYouNotes(1000)    ', 5_000, () => getForYouNotes(notes, 3));
  });

  it('getForYouNotes vs old @ 5000 notes', () => {
    const notes = makeNotes(5000);
    bench('getForYouNotes_old(5000)', 1_000, () => getForYouNotes_old(notes, 3));
    bench('getForYouNotes(5000)    ', 1_000, () => getForYouNotes(notes, 3));
  });
});
