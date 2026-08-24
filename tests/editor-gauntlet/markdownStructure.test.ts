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
  it('rejects Enter that leaves one inline mark spanning a soft line break', () => {
    const result = checkSemanticIntent(snapshot('**alp\nha beta**'), {
      kind: 'bold',
      styledText: ['alp', 'ha beta'],
      visibleText: ['alp', 'ha', 'beta'],
      topology: 'split-paragraphs',
    });

    expect(result.ok).toBe(false);
    expect(result.structureErrors).toContain('expected 2 semantic node(s), found 1');
  });

  it('accepts Enter only when both pieces are marked in distinct paragraphs', () => {
    const source = '**alp**\n\n**ha beta**';
    const rendered = snapshot(source);
    rendered.visibleText = 'alp\n\nha beta';

    expect(
      checkSemanticIntent(rendered, {
        kind: 'bold',
        styledText: ['alp', 'ha beta'],
        visibleText: ['alp', 'ha', 'beta'],
        topology: 'split-paragraphs',
      }),
    ).toMatchObject({ ok: true, structureErrors: [] });
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
