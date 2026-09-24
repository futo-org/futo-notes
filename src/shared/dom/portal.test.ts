// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { portal } from './portal';

function overlay(): HTMLElement {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
}

describe('portal', () => {
  // The sidebar's overlay scrollbar painted on top of an open context menu on
  // Ubuntu — WebKit draws it after the rest of the page. The flag drives the
  // `scrollbar-width: none` rule in stacking.css that takes it out of the way.
  it('flags an open overlay until the last portalled node unmounts', () => {
    const flagged = () => document.documentElement.hasAttribute('data-overlay-open');
    const first = portal(overlay());
    expect(flagged()).toBe(true);
    const second = portal(overlay());

    first.destroy();
    expect(flagged()).toBe(true);

    second.destroy();
    expect(flagged()).toBe(false);
  });
});
