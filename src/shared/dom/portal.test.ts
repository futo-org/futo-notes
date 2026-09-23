// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { portal } from './portal';

function overlay(): HTMLElement {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return node;
}

afterEach(() => {
  document.documentElement.removeAttribute('data-overlay-open');
  document.body.innerHTML = '';
});

describe('portal', () => {
  it('moves the node to the body', () => {
    const host = document.createElement('div');
    const node = document.createElement('div');
    host.appendChild(node);
    document.body.appendChild(host);

    const handle = portal(node);

    expect(node.parentElement).toBe(document.body);
    handle.destroy();
  });

  // The sidebar's overlay scrollbar painted on top of an open context menu on
  // Ubuntu — WebKit draws it after the rest of the page. The flag drives the
  // `scrollbar-width: none` rule in stacking.css that takes it out of the way.
  it('flags an open overlay while a portalled node is mounted', () => {
    const handle = portal(overlay());
    expect(document.documentElement.hasAttribute('data-overlay-open')).toBe(true);

    handle.destroy();
    expect(document.documentElement.hasAttribute('data-overlay-open')).toBe(false);
  });

  it('keeps the flag until the last of several overlays closes', () => {
    const first = portal(overlay());
    const second = portal(overlay());

    first.destroy();
    expect(document.documentElement.hasAttribute('data-overlay-open')).toBe(true);

    second.destroy();
    expect(document.documentElement.hasAttribute('data-overlay-open')).toBe(false);
  });
});
