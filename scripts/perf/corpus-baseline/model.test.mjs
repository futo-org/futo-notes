import { Buffer } from 'node:buffer';
import { describe as suite, it, expect } from 'vitest';
import { describe, summarize, percentile, select } from './model.mjs';
const note = (body, hash = 'abc') => ({
  body,
  content_hash: hash,
  source_type: 'test',
  source_id: 'test',
});
suite('corpus structure measurements', () => {
  it('excludes fenced examples and counts nested list items, not continuation lines', () => {
    const r = describe(
      note(
        '```md\n- fake\n- list\n```\n\n- real\n  continuation\n  - child\n- last\n\nA paragraph\nwith a soft wrap.',
      ),
    );
    expect(r.listItems).toBe(3);
    expect(r.blocks.listItems.depth).toBe(2);
    expect(r.paragraphChars).toBe('A paragraph\nwith a soft wrap.'.length);
  });
  it('recognizes GFM tables and does not count a pipe paragraph as a table', () => {
    const r = describe(note('a | b\n--- | ---\nx | y\n\nnot | a table'));
    expect(r.tableCells).toBe(4);
    expect(r.blocks.tableCells.rows).toBe(2);
    expect(r.blocks.tableCells.columns).toBe(2);
  });
  it('counts empty table slots using delimiter columns', () => {
    const r = describe(note('| | b | |\n|---|---|---|\n| c | | d |'));
    expect(r.tableCells).toBe(6);
    expect(r.blocks.tableCells.columns).toBe(3);
  });
  it('uses nearest rank and one maximum per note, conditioned on feature', () => {
    const records = [describe(note('- a\n- b', '1')), describe(note('plain', '2'))];
    expect(summarize(records).listItems).toEqual({
      containingNotes: 1,
      totalNotes: 2,
      percentiles: { p50: 2, p95: 2, p99: 2, p100: 2 },
    });
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
    expect(percentile([], 95)).toBeNull();
  });
  it('keeps original whole notes and emits UTF-8 targets at literal text', () => {
    const notes = [note('😃 **hello**\n\n- item\n\n| a | b |\n|---|---|\n| c | d |', '1')];
    const picks = select(notes.map(describe), notes, 1);
    expect(picks).toHaveLength(16);
    for (const p of picks) {
      expect(p.body).toBe(notes[0].body);
      expect(Buffer.byteLength(p.body.slice(0, p.sourceUtf16))).toBe(p.sourceByte);
      expect(p.body[p.sourceUtf16 - 1]).toMatch(/[a-z]/);
    }
  });
});
