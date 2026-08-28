// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearVaultImageUrlCache,
  registerVaultImageUrl,
  setVaultImageBaseUrl,
} from '$features/images/vaultImageSrc';

import { testSchema } from './__fixtures__/schema';
import { VaultImageNodeView } from './vaultImageView';

function imageNode(attrs: { src: string; alt?: string; title?: string }) {
  return testSchema.nodes.image.create({ alt: '', title: '', ...attrs });
}

beforeEach(() => {
  clearVaultImageUrlCache();
  setVaultImageBaseUrl('');
});

describe('VaultImageNodeView', () => {
  it('renders an img resolved against the vault base URL', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'photo.png', alt: 'a cat' }));

    expect(view.dom.tagName).toBe('IMG');
    expect(view.dom.getAttribute('src')).toBe('futo-asset://vault/photo.png');
    expect(view.dom.getAttribute('alt')).toBe('a cat');
  });

  it('carries the on-disk reference in data-futo-src, never the resolved URL', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'photo.png' }));

    expect(view.dom.dataset.futoSrc).toBe('photo.png');
  });

  it('leaves src unset — no broken-image glyph — until the base URL arrives', () => {
    const view = new VaultImageNodeView(imageNode({ src: 'photo.png' }));
    expect(view.dom.hasAttribute('src')).toBe(false);

    setVaultImageBaseUrl('futo-asset://vault/');
    expect(view.dom.getAttribute('src')).toBe('futo-asset://vault/photo.png');
  });

  it('re-resolves when a per-file URL is registered after mount (desktop)', () => {
    const view = new VaultImageNodeView(imageNode({ src: 'photo.png' }));
    registerVaultImageUrl('photo.png', 'blob:resolved-late');
    expect(view.dom.getAttribute('src')).toBe('blob:resolved-late');
  });

  it('passes a remote source through untouched', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'https://example.com/a.png' }));
    expect(view.dom.getAttribute('src')).toBe('https://example.com/a.png');
  });

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

  it('sets title only when the node has one', () => {
    setVaultImageBaseUrl('futo-asset://vault/');
    const view = new VaultImageNodeView(imageNode({ src: 'a.png', title: 'hover me' }));
    expect(view.dom.getAttribute('title')).toBe('hover me');

    view.update(imageNode({ src: 'a.png', title: '' }));
    expect(view.dom.hasAttribute('title')).toBe(false);
  });
});
