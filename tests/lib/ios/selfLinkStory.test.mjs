import { describe, expect, it, vi } from 'vitest';

vi.mock('../../ios-editor-stories/story-runner.mjs', () => ({ device: {} }));

import { selfLinkTypedLanded } from '../../ios-editor-stories/self-link-story.mjs';

describe('self-link rename story disk oracle', () => {
  it.each(['back to [[SelfyX]]qq77\n', 'back to [[SelfyX]]\nqq77\n', 'Qq77back to [[SelfyX]]\n'])(
    'accepts the typed marker without requiring the old trailing newline position: %j',
    (body) => {
      expect(selfLinkTypedLanded(body)).toBe(true);
    },
  );

  it.each([
    'back to [[SelfyX]]\n',
    'back to [[SelfyX]]\nWRONG\n',
    'back to [[Selfy]]qq77\n',
    'back to [[SelfyX]]qq77LOST DATA\n',
  ])('rejects missing input, stale links, or unrelated changes: %j', (body) => {
    expect(selfLinkTypedLanded(body)).toBe(false);
  });
});
