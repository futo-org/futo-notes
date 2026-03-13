import { describe, expect, it } from 'vitest';
import {
  findHeadingSection,
  findManagedBlock,
  renderManagedBlock,
  replaceHeadingSection,
  replaceManagedBlock,
} from '../../src/plugins/managedBlocks.js';

describe('managedBlocks', () => {
  it('renders a managed block with stable markers', () => {
    expect(renderManagedBlock('example-block', '## Related\n- [[Note]]')).toBe(
      '<!-- stonefruit:example-block:start -->\n## Related\n- [[Note]]\n<!-- stonefruit:example-block:end -->',
    );
  });

  it('appends a block to the end of a note when missing', () => {
    const next = replaceManagedBlock('Intro\nBody', 'example-block', '## Related\n- [[Note]]');
    expect(next).toBe(
      'Intro\nBody\n\n<!-- stonefruit:example-block:start -->\n## Related\n- [[Note]]\n<!-- stonefruit:example-block:end -->',
    );
  });

  it('replaces an existing block in place', () => {
    const original = [
      'Intro',
      '',
      '<!-- stonefruit:example-block:start -->',
      '## Related',
      '- [[Old]]',
      '<!-- stonefruit:example-block:end -->',
      '',
      'Footer',
    ].join('\n');
    const next = replaceManagedBlock(original, 'example-block', '## Related\n- [[New]]');
    expect(next).toBe(
      'Intro\n\n<!-- stonefruit:example-block:start -->\n## Related\n- [[New]]\n<!-- stonefruit:example-block:end -->\n\nFooter',
    );
    expect(findManagedBlock(next, 'example-block')).toBe(
      '<!-- stonefruit:example-block:start -->\n## Related\n- [[New]]\n<!-- stonefruit:example-block:end -->',
    );
  });

  it('finds and replaces a heading-owned section without marker comments', () => {
    const original = [
      '# Weekly',
      '',
      '## Related Notes',
      '- [[Old note]] - Previous reason.',
      '',
      '## Next',
      'More text',
    ].join('\n');
    const nextSection = '## Related Notes\n- [[Fresh note]] - Updated reason.';

    expect(findHeadingSection(original, '## Related Notes')).toBe(
      '## Related Notes\n- [[Old note]] - Previous reason.',
    );
    expect(replaceHeadingSection(original, '## Related Notes', nextSection)).toBe(
      '# Weekly\n\n## Related Notes\n- [[Fresh note]] - Updated reason.\n\n## Next\nMore text',
    );
  });
});
