import { describe, expect, it } from 'vitest';

import { markdownBlockRanges, semanticNodes } from './markdownStructure';
import { checkSemanticIntent } from './semanticIntent';
import type { EditorSnapshot } from './types';

function snapshot(source: string, kind: 'bold' = 'bold'): EditorSnapshot {
  const nodes = semanticNodes(source, kind);
  return {
    source,
    shellSource: source,
    savedSource: source,
    visibleText: source,
    decorations: nodes.map((node) => ({
      from: { line: 0, ch: node.from, pos: node.from },
      to: { line: 0, ch: node.to, pos: node.to },
      kind: 'bold-text',
      replaced: false,
      classes: ['cm-md-strong'],
      text: node.text,
    })),
    warnings: [],
    refused: false,
    mode: 'rich',
  };
}

describe('editor gauntlet markdown structure oracle', () => {
  it('accepts Enter that carries one inline mark across the new line', () => {
    const source = '**alp\nha beta**';
    const rendered = snapshot(source);
    rendered.visibleText = 'alp\nha beta';

    expect(
      checkSemanticIntent(rendered, {
        kind: 'bold',
        styledText: ['alp\nha beta'],
        visibleText: ['alp', 'ha', 'beta'],
        topology: 'split-lines',
      }),
    ).toMatchObject({ ok: true, structureErrors: [] });
  });

  it('rejects Enter that splits the run into separate paragraphs', () => {
    const result = checkSemanticIntent(snapshot('**alp**\n\n**ha beta**'), {
      kind: 'bold',
      styledText: ['alp\nha beta'],
      visibleText: ['alp', 'ha', 'beta'],
      topology: 'split-lines',
    });

    expect(result.ok).toBe(false);
    expect(result.structureErrors).toEqual(
      expect.arrayContaining([
        'expected 1 semantic node(s), found 2',
        'semantic nodes are not lines of one paragraph',
      ]),
    );
  });

  it('rejects a run that never got its line break', () => {
    const result = checkSemanticIntent(snapshot('**alpha beta**'), {
      kind: 'bold',
      styledText: ['alpha beta'],
      visibleText: ['alpha', 'beta'],
      topology: 'split-lines',
    });

    expect(result.structureErrors).toContain('semantic run has no line break');
  });

  it('rejects a Backspace join that leaves the marks in separate paragraphs', () => {
    const source = '**alpha**\n\n**beta**';
    expect(
      checkSemanticIntent(snapshot(source), {
        kind: 'bold',
        styledText: ['alphabeta'],
        visibleText: ['alphabeta'],
        topology: 'joined-contiguous',
      }).structureErrors,
    ).toEqual(
      expect.arrayContaining([
        'semantic nodes do not share one paragraph',
        'joined semantic run still contains a line break',
      ]),
    );
  });

  it('rejects two marked nodes when Backspace requires one merged semantic run', () => {
    const source = '**alpha** **beta**';
    expect(
      checkSemanticIntent(snapshot(source), {
        kind: 'bold',
        styledText: ['alphabeta'],
        visibleText: ['alphabeta'],
        topology: 'joined-contiguous',
      }).structureErrors,
    ).toContain('expected 1 semantic node(s), found 2');
  });

  it('accepts a Backspace join only as one contiguous marked run', () => {
    const source = '**alphabeta**';
    const rendered = snapshot(source);
    rendered.visibleText = 'alphabeta';

    expect(
      checkSemanticIntent(rendered, {
        kind: 'bold',
        styledText: ['alphabeta'],
        visibleText: ['alphabeta'],
        topology: 'joined-contiguous',
      }),
    ).toMatchObject({ ok: true, structureErrors: [] });
  });

  it('keeps blank lines inside fenced code and lists within parser-owned blocks', () => {
    const source = [
      '```md',
      'first',
      '',
      'second',
      '```',
      '',
      '- one',
      '  continuation',
      '',
      'tail',
    ].join('\n');
    const ranges = markdownBlockRanges(source).map((range) => source.slice(range.from, range.to));

    expect(ranges[0]).toBe('```md\nfirst\n\nsecond\n```');
    expect(ranges).toContain('- one\n  continuation');
    expect(ranges.at(-1)).toBe('tail');
  });
});
