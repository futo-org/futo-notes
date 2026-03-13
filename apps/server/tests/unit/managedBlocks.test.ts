import { describe, expect, it } from 'vitest';
import { findManagedBlock, renderManagedBlock, replaceManagedBlock } from '../../src/plugins/managedBlocks.js';

describe('managedBlocks', () => {
  it('renders a managed block with stable markers', () => {
    expect(renderManagedBlock('weekly-related-notes', '## Related\n- [[Note]]')).toBe(
      '<!-- stonefruit:weekly-related-notes:start -->\n## Related\n- [[Note]]\n<!-- stonefruit:weekly-related-notes:end -->',
    );
  });

  it('appends a block to the end of a note when missing', () => {
    const next = replaceManagedBlock('Intro\nBody', 'weekly-related-notes', '## Related\n- [[Note]]');
    expect(next).toBe(
      'Intro\nBody\n\n<!-- stonefruit:weekly-related-notes:start -->\n## Related\n- [[Note]]\n<!-- stonefruit:weekly-related-notes:end -->',
    );
  });

  it('replaces an existing block in place', () => {
    const original = [
      'Intro',
      '',
      '<!-- stonefruit:weekly-related-notes:start -->',
      '## Related',
      '- [[Old]]',
      '<!-- stonefruit:weekly-related-notes:end -->',
      '',
      'Footer',
    ].join('\n');
    const next = replaceManagedBlock(original, 'weekly-related-notes', '## Related\n- [[New]]');
    expect(next).toBe(
      'Intro\n\n<!-- stonefruit:weekly-related-notes:start -->\n## Related\n- [[New]]\n<!-- stonefruit:weekly-related-notes:end -->\n\nFooter',
    );
    expect(findManagedBlock(next, 'weekly-related-notes')).toBe(
      '<!-- stonefruit:weekly-related-notes:start -->\n## Related\n- [[New]]\n<!-- stonefruit:weekly-related-notes:end -->',
    );
  });
});
