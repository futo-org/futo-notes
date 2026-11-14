import { it, expect } from 'vitest';
import { validateCollection } from './android-text-first-bench.mjs';
const manifest = [{ label: 'paragraph-p95', cell: false }];
const complete = () => ({
  notes: [
    {
      label: manifest[0].label,
      actions: ['type', 'enter', 'backspace'].map((action) => ({
        action,
        samples: 50,
        requested: 50,
        p95Ns: 100_000_000,
        timedOut: 0,
        refused: 0,
      })),
    },
  ],
});
it('accepts slow complete collection without inventing a speed gate', () => {
  expect(() => validateCollection(complete(), manifest, true)).not.toThrow();
});
it('rejects partial, missing, refused and timed-out series', () => {
  for (const mutate of [
    (r) => r.notes.pop(),
    (r) => r.notes[0].actions.pop(),
    (r) => (r.notes[0].actions[0].timedOut = 1),
    (r) => (r.notes[0].actions[0].refused = 1),
    (r) => (r.notes[0].actions[0].samples = 1),
  ]) {
    const r = complete();
    mutate(r);
    expect(() => validateCollection(r, manifest, true)).toThrow();
  }
});
it('rejects a report for a different fixture', () => {
  const r = complete();
  r.notes[0].label = 'another';
  expect(() => validateCollection(r, manifest, true)).toThrow(/identity/);
});
