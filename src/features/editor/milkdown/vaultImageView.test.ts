// @vitest-environment jsdom
/*
 * What the node view does that the bundle-level spec CANNOT see.
 *
 * `tests/editor-embed-milkdown.spec.ts` owns the rendering behavior — resolved
 * src, the late base URL, remote passthrough, alt, and the vault reference
 * never reaching the note — asserted at the host seam, which is where #97's
 * testing decisions put it. What is left here is the node-view contract
 * ProseMirror relies on and no rendered DOM reveals: that an update reuses the
 * element instead of reloading the image, that an unchanged src is not re-set,
 * that a foreign node type is refused, and that destroy really unsubscribes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearVaultImageUrlCache,
  registerVaultImageUrl,
  setVaultImageBaseUrl,
  setVaultImageUrlResolver,
} from '$features/images/vaultImageSrc';

import { testSchema } from './__fixtures__/schema';
import { VaultImageNodeView } from './vaultImageView';

function imageNode(attrs: { src: string; alt?: string; title?: string }) {
  return testSchema.nodes.image.create({ alt: '', title: '', ...attrs });
}

beforeEach(() => {
  clearVaultImageUrlCache();
  setVaultImageBaseUrl('');
  setVaultImageUrlResolver(null);
});

describe('VaultImageNodeView', () => {
  it('updates in place for a new image node and keeps the same img element', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'one.png' }));
    const element = view.dom;

    expect(view.update(imageNode({ src: 'two.png', alt: 'two' }))).toBe(true);
    expect(view.dom).toBe(element);
    expect(view.dom.getAttribute('src')).toBe('futo-asset://vault/two.png');
    expect(view.dom.getAttribute('alt')).toBe('two');
  });

  it('does not touch the src attribute when the resolved URL is unchanged', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'one.png' }));
    let sets = 0;
    const original = view.dom.setAttribute.bind(view.dom);
    view.dom.setAttribute = (name: string, value: string) => {
      if (name === 'src') sets += 1;
      original(name, value);
    };

    view.update(imageNode({ src: 'one.png', alt: 'now with alt' }));
    expect(sets).toBe(0);
    expect(view.dom.getAttribute('alt')).toBe('now with alt');
  });

  it('refuses an update to a different node type', () => {
    const view = new VaultImageNodeView(imageNode({ src: 'one.png' }));
    expect(view.update(testSchema.nodes.paragraph.create())).toBe(false);
  });

  it('tells ProseMirror to ignore its own DOM mutations', () => {
    const view = new VaultImageNodeView(imageNode({ src: 'one.png' }));
    expect(view.ignoreMutation()).toBe(true);
  });

  it('stops re-resolving once destroyed', () => {
    const view = new VaultImageNodeView(imageNode({ src: 'photo.png' }));
    view.destroy();
    setVaultImageBaseUrl('futo-asset://vault/');
    expect(view.dom.hasAttribute('src')).toBe(false);
  });

  /* Tauri desktop has no base URL: each file resolves individually and
   * asynchronously, so the view has to ASK and then re-render. Only reachable
   * here — the embed bundle has no filesystem to resolve against. */
  it('asks the host to resolve a filename nothing can resolve yet, then renders it', async () => {
    const resolve = vi.fn().mockResolvedValue('asset://vault/desktop.png');
    setVaultImageUrlResolver(resolve);

    const view = new VaultImageNodeView(imageNode({ src: 'desktop.png' }));

    expect(resolve).toHaveBeenCalledWith('desktop.png');
    await vi.waitFor(() => expect(view.dom.getAttribute('src')).toBe('asset://vault/desktop.png'));
  });

  it('never asks when the base URL already answers (the native shells)', () => {
    const resolve = vi.fn();
    setVaultImageUrlResolver(resolve);
    setVaultImageBaseUrl('futo-asset://vault/');

    new VaultImageNodeView(imageNode({ src: 'native.png' }));

    expect(resolve).not.toHaveBeenCalled();
  });
});
