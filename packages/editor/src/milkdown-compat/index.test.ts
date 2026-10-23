import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commonmark from '@milkdown/kit/preset/commonmark';
import * as gfm from '@milkdown/kit/preset/gfm';

// Snapshot once: resetting modules while re-importing the kit's export-star
// facades through importOriginal can leave their live exports uninitialized.
const upstreamCommonmark = { ...commonmark };
const upstreamGfm = { ...gfm };

beforeEach(() => {
  vi.doMock('@milkdown/kit/preset/commonmark', () => ({ ...upstreamCommonmark }));
  vi.doMock('@milkdown/kit/preset/gfm', () => ({ ...upstreamGfm }));
});

afterEach(() => {
  vi.doUnmock('@milkdown/kit/preset/commonmark');
  vi.doUnmock('@milkdown/kit/preset/gfm');
  vi.resetModules();
});

describe('compat preset composition', () => {
  it('keeps plugin identities stable across editor instances', async () => {
    const { commonmarkWithCompat, gfmWithCompat } = await import('./index');
    expect(commonmarkWithCompat()).toBe(commonmarkWithCompat());
    expect(gfmWithCompat()).toBe(gfmWithCompat());
  });

  it('replaces the inline cursor at its original event-handling priority', async () => {
    const upstream = await import('@milkdown/kit/preset/commonmark');
    const { inlineNodesCursorPlugin } = await import('./inlineNodesCursor');
    const { commonmarkWithCompat } = await import('./index');
    const plugins = commonmarkWithCompat();
    const before = upstream.commonmark.slice(
      0,
      upstream.commonmark.indexOf(upstream.inlineNodesCursorPlugin),
    );
    const after = upstream.commonmark.slice(
      upstream.commonmark.indexOf(upstream.inlineNodesCursorPlugin) + 1,
    );
    const cursorIndex = plugins.indexOf(inlineNodesCursorPlugin);
    expect(cursorIndex).toBeGreaterThanOrEqual(0);
    for (const plugin of before) {
      if (plugins.includes(plugin)) expect(plugins.indexOf(plugin)).toBeLessThan(cursorIndex);
    }
    for (const plugin of after) {
      if (plugins.includes(plugin)) expect(plugins.indexOf(plugin)).toBeGreaterThan(cursorIndex);
    }
    expect(plugins).not.toContain(upstream.inlineNodesCursorPlugin);
  });

  it('refuses a commonmark preset missing a plugin it must remove', async () => {
    vi.doMock('@milkdown/kit/preset/commonmark', () => ({
      ...upstreamCommonmark,
      commonmark: upstreamCommonmark.commonmark.filter(
        (plugin) => plugin !== upstreamCommonmark.syncHeadingIdPlugin,
      ),
    }));
    const { commonmarkWithCompat } = await import('./index');
    expect(commonmarkWithCompat).toThrow(/milkdown-compat:.*heading-id/);
  });

  it('refuses a commonmark preset missing an input rule it must replace', async () => {
    vi.doMock('@milkdown/kit/preset/commonmark', () => ({
      ...upstreamCommonmark,
      commonmark: upstreamCommonmark.commonmark.filter(
        (plugin) => plugin !== upstreamCommonmark.strongInputRule,
      ),
    }));
    const { commonmarkWithCompat } = await import('./index');
    expect(commonmarkWithCompat).toThrow(/milkdown-compat:.*strong input rule/);
  });

  it('refuses a gfm preset containing a duplicated table pass', async () => {
    vi.doMock('@milkdown/kit/preset/gfm', () => ({
      ...upstreamGfm,
      gfm: [...upstreamGfm.gfm, upstreamGfm.tableEditingPlugin],
    }));
    const { gfmWithCompat } = await import('./index');
    expect(gfmWithCompat).toThrow(/milkdown-compat:.*table/);
  });
});
