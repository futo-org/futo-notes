import { describe, expect, it } from 'vitest';
import { parseMarkdownTable } from '$lib/tableWidget';
import {
  addRow,
  addColumn,
  deleteRow,
  deleteColumn,
  moveRow,
  moveColumn,
  setAlign,
  cycleAlign,
  setCellContent,
  serialize,
  type ParsedTable,
} from './tableOps';

function parse(md: string): ParsedTable {
  const t = parseMarkdownTable(md);
  if (!t) throw new Error('parse failed');
  return t;
}

const BASIC = `| A | B |
| --- | --- |
| 1 | 2 |
| 3 | 4 |`;

describe('serialize round-trip', () => {
  it('round-trips a basic table', () => {
    const t = parse(BASIC);
    expect(serialize(t)).toBe(BASIC);
  });

  it('canonicalizes alignment markers', () => {
    const t = parse(`| A | B |\n|:-:|---:|\n| x | y |`);
    expect(serialize(t)).toBe('| A | B |\n| :---: | ---: |\n| x | y |');
  });

  it('escapes pipes in cell content', () => {
    let t = parse(BASIC);
    t = setCellContent(t, 0, 0, 'a | b');
    expect(serialize(t)).toContain('a \\| b');
  });
});

describe('addRow', () => {
  it('appends at end', () => {
    let t = parse(BASIC);
    t = addRow(t, t.rows.length);
    expect(t.rows.length).toBe(3);
    expect(t.rows[2].map((c) => c.content)).toEqual(['', '']);
  });

  it('inserts in the middle', () => {
    let t = parse(BASIC);
    t = addRow(t, 1);
    expect(t.rows.length).toBe(3);
    expect(t.rows[0].map((c) => c.content)).toEqual(['1', '2']);
    expect(t.rows[1].map((c) => c.content)).toEqual(['', '']);
    expect(t.rows[2].map((c) => c.content)).toEqual(['3', '4']);
  });

  it('inherits column alignments', () => {
    let t = parse(`| A | B |\n|:---:|---:|\n| x | y |`);
    t = addRow(t, t.rows.length);
    expect(t.rows[1].map((c) => c.align)).toEqual(['center', 'right']);
  });
});

describe('deleteRow', () => {
  it('removes the given row', () => {
    let t = parse(BASIC);
    t = deleteRow(t, 0);
    expect(t.rows.length).toBe(1);
    expect(t.rows[0].map((c) => c.content)).toEqual(['3', '4']);
  });

  it('is a no-op for out-of-range index', () => {
    const t = parse(BASIC);
    expect(deleteRow(t, 99)).toBe(t);
  });
});

describe('moveRow', () => {
  it('swaps two rows', () => {
    let t = parse(BASIC);
    t = moveRow(t, 0, 1);
    expect(t.rows[0].map((c) => c.content)).toEqual(['3', '4']);
    expect(t.rows[1].map((c) => c.content)).toEqual(['1', '2']);
  });

  it('is a no-op for same index', () => {
    const t = parse(BASIC);
    expect(moveRow(t, 0, 0)).toBe(t);
  });
});

describe('addColumn', () => {
  it('appends at end', () => {
    let t = parse(BASIC);
    t = addColumn(t, 2);
    expect(t.headers.length).toBe(3);
    expect(t.rows[0].length).toBe(3);
    expect(t.alignments.length).toBe(3);
  });

  it('inserts in middle', () => {
    let t = parse(BASIC);
    t = addColumn(t, 1, 'center');
    expect(t.headers.map((c) => c.content)).toEqual(['A', '', 'B']);
    expect(t.alignments).toEqual(['left', 'center', 'left']);
    expect(t.rows[0].map((c) => c.content)).toEqual(['1', '', '2']);
  });
});

describe('deleteColumn', () => {
  it('removes a middle column', () => {
    let t = parse(`| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |`);
    t = deleteColumn(t, 1);
    expect(t.headers.map((c) => c.content)).toEqual(['A', 'C']);
    expect(t.rows[0].map((c) => c.content)).toEqual(['1', '3']);
  });

  it('refuses to delete the last column', () => {
    const t = parse(`| A |\n| --- |\n| 1 |`);
    expect(deleteColumn(t, 0)).toBe(t);
  });
});

describe('moveColumn', () => {
  it('swaps columns', () => {
    let t = parse(BASIC);
    t = moveColumn(t, 0, 1);
    expect(t.headers.map((c) => c.content)).toEqual(['B', 'A']);
    expect(t.rows[0].map((c) => c.content)).toEqual(['2', '1']);
  });
});

describe('setAlign', () => {
  it('sets alignment on header, alignments, and all rows', () => {
    let t = parse(BASIC);
    t = setAlign(t, 1, 'right');
    expect(t.alignments[1]).toBe('right');
    expect(t.headers[1].align).toBe('right');
    expect(t.rows[0][1].align).toBe('right');
    expect(t.rows[1][1].align).toBe('right');
    // Serialization reflects it
    expect(serialize(t)).toContain('---:');
  });
});

describe('cycleAlign', () => {
  it('cycles left → center → right → left', () => {
    expect(cycleAlign('left')).toBe('center');
    expect(cycleAlign('center')).toBe('right');
    expect(cycleAlign('right')).toBe('left');
  });
});

describe('setCellContent', () => {
  it('updates a header cell with rowIndex === -1', () => {
    let t = parse(BASIC);
    t = setCellContent(t, -1, 0, 'Name');
    expect(t.headers[0].content).toBe('Name');
    expect(serialize(t)).toContain('| Name | B |');
  });

  it('updates a data cell', () => {
    let t = parse(BASIC);
    t = setCellContent(t, 1, 1, 'changed');
    expect(t.rows[1][1].content).toBe('changed');
  });

  it('is a no-op for out-of-range coordinates', () => {
    const t = parse(BASIC);
    expect(setCellContent(t, 99, 0, 'x')).toBe(t);
    expect(setCellContent(t, 0, 99, 'x')).toBe(t);
  });
});
