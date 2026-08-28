/*
 * How a vault image reaches the screen in the Milkdown (ProseMirror) editor.
 *
 * A note stores images by bare vault filename — `![](image-1712.png)` — and
 * that is exactly what must stay on disk. The commonmark preset's `image` node
 * renders `attrs.src` straight into `<img src>`, which no shell can load: iOS
 * serves the vault over `futo-asset://`, Android over a WebViewAssetLoader
 * path, and desktop over the Tauri asset protocol. So the rendering is
 * overridden here while `attrs.src` — the serialized reference — is never
 * touched. There is no way for a resolved URL to reach the file.
 *
 * This replaces a post-render DOM sweep (`rewriteImageSrcs`, deleted with this
 * module's arrival) that had three problems a node view does not:
 *
 *   1. It ran off the 200 ms-debounced `markdownUpdated` listener, so any
 *      transaction that re-rendered an image showed the raw filename — a
 *      broken-image glyph — until the debounce fired.
 *   2. It mutated ProseMirror-managed DOM with nothing telling ProseMirror to
 *      ignore the mutation, so the rewritten `src` could be read back into the
 *      document. `ignoreMutation` closes that.
 *   3. Nothing re-resolved when the host registered the base URL AFTER the
 *      content, or when a desktop `getImageUrl` resolved asynchronously.
 *      `onVaultImageSrcChange` covers both.
 */
import { imageSchema } from '@milkdown/kit/preset/commonmark';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { NodeView } from '@milkdown/kit/prose/view';
import { $view } from '@milkdown/kit/utils';

import { onVaultImageSrcChange, resolveVaultImageSrc } from '$features/images/vaultImageSrc';

export class VaultImageNodeView implements NodeView {
  readonly dom: HTMLImageElement;

  private node: ProseNode;
  private readonly unsubscribe: () => void;

  constructor(node: ProseNode) {
    this.node = node;
    this.dom = document.createElement('img');
    this.unsubscribe = onVaultImageSrcChange(() => this.render());
    this.render();
  }

  update(node: ProseNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  /**
   * Every mutation inside this view is one `render()` made — the `src`, `alt`
   * and `title` attributes. Letting ProseMirror re-read them as document
   * content is how a resolved URL would get written back into `attrs.src` and
   * from there into the note on disk.
   */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.unsubscribe();
  }

  private render(): void {
    const source = String(this.node.attrs.src ?? '');
    const alt = String(this.node.attrs.alt ?? '');
    const title = String(this.node.attrs.title ?? '');

    if (this.dom.getAttribute('alt') !== alt) this.dom.setAttribute('alt', alt);
    if (title) {
      if (this.dom.getAttribute('title') !== title) this.dom.setAttribute('title', title);
    } else if (this.dom.hasAttribute('title')) {
      this.dom.removeAttribute('title');
    }

    /* The reference as the note spells it, so what is rendered can be matched
     * back to what is stored — the assertion the embed spec makes, and the
     * first thing to look at when an image renders blank on a device. */
    this.dom.dataset.futoSrc = source;

    const resolved = resolveVaultImageSrc(source);
    if (!resolved) {
      /* No base URL yet, or nothing registered for this filename. An unset src
       * renders as nothing; the raw filename would render a broken-image glyph
       * and then get replaced once the host catches up. */
      if (this.dom.hasAttribute('src')) this.dom.removeAttribute('src');
      return;
    }
    // Re-setting an unchanged src restarts the load and re-flashes the image.
    if (this.dom.getAttribute('src') !== resolved) this.dom.setAttribute('src', resolved);
  }
}

/** The Milkdown plugin that installs the node view. */
export const vaultImageView = $view(imageSchema.node, () => (node) => new VaultImageNodeView(node));
