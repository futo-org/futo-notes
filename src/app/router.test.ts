import { describe, expect, it } from 'vitest';

import { resolveDesktopWikilinkTarget } from './router';

describe('resolveDesktopWikilinkTarget', () => {
  it('opens an unambiguous leaf link at its canonical foldered note id', () => {
    expect(resolveDesktopWikilinkTarget('Roadmap', ['Projects/Roadmap', 'Archive/Notes'])).toBe(
      'Projects/Roadmap',
    );
  });

  it('keeps a broken or ambiguous target for deferred creation', () => {
    expect(resolveDesktopWikilinkTarget('Missing', ['Projects/Roadmap'])).toBe('Missing');
    expect(resolveDesktopWikilinkTarget('Roadmap', ['A/Roadmap', 'B/Roadmap'])).toBe('Roadmap');
  });
});
