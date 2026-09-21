/*
 * The `/` menu's DOM.
 *
 * Positioning is NOT here — `SlashProvider` (@milkdown/plugin-slash) owns it,
 * with the same floating-ui `computePosition` + `flip` the ⠿ block handle
 * already runs through @milkdown/plugin-block. This class only renders rows and
 * reports which one the pointer chose.
 *
 * `textContent = ''` + `appendChild`, never `replaceChildren`: the editor's
 * WebView floor is Chromium 80 and `replaceChildren` is 86 (github#8,
 * docs/spec/editor.md; tests/editor-embed-webview-floor.spec.ts audits the
 * built bundle for exactly this). The wikilink suggestion popup carries the
 * same note — the last time it shipped it crashed the menu on Chromium 80-85.
 */
import { localizedText } from '$shared/localization';

import type { SlashItem } from './items';

export class SlashMenu {
  readonly dom: HTMLDivElement;
  private readonly list: HTMLUListElement;

  constructor(private readonly onPick: (index: number) => void) {
    this.dom = document.createElement('div');
    this.dom.className = 'futo-slash-menu';
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', localizedText('editor.slashMenu.heading'));
    this.list = document.createElement('ul');
    this.dom.appendChild(this.list);
    /*
     * Prevent the MOUSEDOWN, pick on the CLICK — in that order, and it matters.
     *
     * A prevented mousedown is what stops the browser moving focus and the
     * document selection to this menu, so the caret is still in the note when
     * the pick runs. Picking on `pointerdown` instead (which is what the
     * wikilink suggestion popup does) leaves the browser a `mouseup` and a
     * `click` still to deliver on an element outside the editable, and those
     * moved the selection out from under the caret the pick had just placed:
     * measured, `/task` clicked gave a correct `- [ ] ` document with the next
     * typed word landing in the paragraph AFTER the list, where the same item
     * taken with Enter typed into the item.
     *
     * The wikilink popup cannot do this — a prevented mousedown cancels the
     * click outright on iOS WebKit, and it runs on phones. This menu is desktop
     * only (`resolveSlashMenu`), so `click` is simply the right event.
     */
    this.dom.addEventListener('mousedown', (event) => event.preventDefault());
    this.dom.addEventListener('click', (event) => {
      const row = (event.target as HTMLElement | null)?.closest('li');
      if (!row?.parentElement) return;
      event.preventDefault();
      this.onPick(Array.prototype.indexOf.call(row.parentElement.children, row));
    });
  }

  render(items: SlashItem[], selected: number): void {
    this.list.textContent = '';
    items.forEach((item, index) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === selected));
      row.dataset.slashId = item.id;

      const label = document.createElement('span');
      label.className = 'futo-slash-menu-label';
      label.textContent = localizedText(item.labelPath);
      row.appendChild(label);

      const hint = document.createElement('span');
      hint.className = 'futo-slash-menu-hint';
      hint.textContent = localizedText(item.hintPath);
      row.appendChild(hint);

      this.list.appendChild(row);
    });
    this.list.children[selected]?.scrollIntoView({ block: 'nearest' });
  }

  destroy(): void {
    this.dom.remove();
  }
}
