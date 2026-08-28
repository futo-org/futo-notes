import { describe, expect, it } from 'vitest';

import { escapeAmbiguousBulletNumbers } from './bulletNumbers';

describe('escapeAmbiguousBulletNumbers', () => {
  it('escapes a digit-dot directly after a bullet marker', () => {
    expect(escapeAmbiguousBulletNumbers('* 0. item one\n* 1. item two\n')).toBe(
      '* 0\\. item one\n* 1\\. item two\n',
    );
  });

  it('handles every bullet marker and both punctuation forms', () => {
    expect(escapeAmbiguousBulletNumbers('- 2) a\n+ 3. b\n* 4) c\n')).toBe(
      '- 2\\) a\n+ 3\\. b\n* 4\\) c\n',
    );
  });

  it('escapes a bullet indented up to CommonMark’s three spaces', () => {
    expect(escapeAmbiguousBulletNumbers('   * 1. x\n')).toBe('   * 1\\. x\n');
  });

  it('leaves a digit-dot later in the item text alone', () => {
    const input = '* see step 2. above\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('leaves a real ordered list alone', () => {
    const input = '1. first\n2. second\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('leaves a task list alone', () => {
    const input = '* [ ] todo\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('does not touch a fenced code block', () => {
    const input = '```md\n* 0. sample\n```\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('does not touch a tilde-fenced code block', () => {
    const input = '~~~\n* 0. sample\n~~~\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('does not touch an inline code span', () => {
    const input = 'write `* 0. thing` like this\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('needs whitespace or end of line after the punctuation', () => {
    const input = '* 1.5 litres\n';
    expect(escapeAmbiguousBulletNumbers(input)).toBe(input);
  });

  it('escapes a bare numbered bullet with nothing after it', () => {
    expect(escapeAmbiguousBulletNumbers('* 1.\n')).toBe('* 1\\.\n');
  });
});
