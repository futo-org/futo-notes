import { describe, expect, it } from 'vitest';
import { Schema, type Node as ProseNode } from '@milkdown/kit/prose/model';

import {
  endsInUnwrittenBlank,
  endsWithUnwrittenLine,
  hasSurplusTrailingEmptyParagraphs,
  writtenContentEnd,
} from './trailingParagraph';

/** The preset's node names, which these checks match on. */
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    heading: { content: 'inline*', group: 'block' },
    horizontal_rule: { group: 'block' },
    hardbreak: { inline: true, group: 'inline', attrs: { isInline: { default: true } } },
    text: { group: 'inline' },
  },
});

/** A paragraph from text, where every `\n` is the inline line break. */
function p(text = ''): ProseNode {
  const content: ProseNode[] = [];
  text.split('\n').forEach((line, index) => {
    if (index > 0) content.push(schema.node('hardbreak'));
    if (line !== '') content.push(schema.text(line));
  });
  return schema.node('paragraph', null, content);
}
const h = (text: string): ProseNode => schema.node('heading', null, [schema.text(text)]);
const hr = (): ProseNode => schema.node('horizontal_rule');
const doc = (...blocks: ProseNode[]): ProseNode => schema.node('doc', null, blocks);

describe('endsWithUnwrittenLine', () => {
  it('is true when the last written paragraph ends in a line break', () => {
    expect(endsWithUnwrittenLine(doc(p('hey\n')))).toBe(true);
    expect(endsWithUnwrittenLine(doc(p('hey\n'), p(), p()))).toBe(true);
  });

  it('is false for a note that ends in text or in another block', () => {
    expect(endsWithUnwrittenLine(doc(p('hey')))).toBe(false);
    expect(endsWithUnwrittenLine(doc(p('one\n'), h('T')))).toBe(false);
  });
});

describe('hasSurplusTrailingEmptyParagraphs', () => {
  it('is true past the one empty paragraph a load parks after a non-paragraph', () => {
    expect(hasSurplusTrailingEmptyParagraphs(doc(p('text'), p()))).toBe(true);
    expect(hasSurplusTrailingEmptyParagraphs(doc(hr(), p(), p()))).toBe(true);
  });

  it('is false for what a load itself leaves', () => {
    expect(hasSurplusTrailingEmptyParagraphs(doc(p('text')))).toBe(false);
    expect(hasSurplusTrailingEmptyParagraphs(doc(hr(), p()))).toBe(false);
    expect(hasSurplusTrailingEmptyParagraphs(doc(p()))).toBe(false);
  });
});

describe('endsInUnwrittenBlank', () => {
  it('is true for either kind of unwritten blank, and false for neither', () => {
    expect(endsInUnwrittenBlank(doc(p('text'), p()))).toBe(true);
    expect(endsInUnwrittenBlank(doc(p('hey\n')))).toBe(true);
    expect(endsInUnwrittenBlank(doc(p('hey'), hr(), p()))).toBe(false);
  });
});

describe('writtenContentEnd', () => {
  it('stops before the trailing empty paragraphs a save does not write', () => {
    // hr is 1, each empty paragraph 2.
    expect(writtenContentEnd(doc(hr(), p()))).toBe(1);
    expect(writtenContentEnd(doc(p('ab'), p(), p()))).toBe(4);
  });

  it('is the whole document when its last block is written', () => {
    expect(writtenContentEnd(doc(p('ab')))).toBe(4);
    expect(writtenContentEnd(doc(p(), p('ab')))).toBe(6);
    expect(writtenContentEnd(doc(p('one\n')))).toBe(6);
  });

  it('is 0 for a document holding only empty paragraphs', () => {
    expect(writtenContentEnd(doc(p()))).toBe(0);
  });
});
