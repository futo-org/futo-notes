/* A list anchored at the caret, for the `[[` completion (wikilinkCompletion.ts) and the `/` menu
 * (slashMenu.ts): each row's label and, when it has one, a second line; fixed on the viewport
 * under the caret, above it when there is no room below, inside the window. A press on a row
 * picks it without taking focus from the editor. */

/** Between the caret and the list, and the list and the window's edges, px. */
const GAP = 4;

export interface CaretListRow {
  label: string;
  detail: string | null;
}

export interface CaretListOptions {
  /** The list's class; its rows' label and detail take `<className>-label` and
   *  `<className>-detail`. */
  className: string;
  /** The listbox's accessible name; none for an unnamed list. */
  name?: string;
  onPick: (index: number) => void;
}

export class CaretList {
  private readonly dom: HTMLDivElement;
  private readonly list: HTMLUListElement;
  private readonly className: string;

  constructor({ className, name, onPick }: CaretListOptions) {
    this.className = className;
    this.dom = document.createElement('div');
    this.dom.className = className;
    this.dom.setAttribute('role', 'listbox');
    if (name) this.dom.setAttribute('aria-label', name);
    this.list = document.createElement('ul');
    this.dom.append(this.list);
    this.dom.addEventListener('mousedown', (event) => {
      event.preventDefault();
      const row = (event.target as Element | null)?.closest('li');
      if (row?.parentElement) onPick([...row.parentElement.children].indexOf(row));
    });
  }

  /** Show `rows`, `selected` highlighted, under `caret` (viewport px). */
  show(rows: readonly CaretListRow[], selected: number, caret: DOMRect): void {
    const elements = rows.map((row, index) => {
      const element = document.createElement('li');
      element.setAttribute('role', 'option');
      element.setAttribute('aria-selected', String(index === selected));
      const label = document.createElement('span');
      label.className = `${this.className}-label`;
      label.textContent = row.label;
      element.append(label);
      if (row.detail) {
        const detail = document.createElement('span');
        detail.className = `${this.className}-detail`;
        detail.textContent = row.detail;
        element.append(detail);
      }
      return element;
    });
    this.list.replaceChildren(...elements);
    if (!this.dom.isConnected) document.body.append(this.dom);
    const height = this.dom.offsetHeight;
    const below = caret.bottom + GAP;
    const top =
      below + height <= window.innerHeight ? below : Math.max(GAP, caret.top - GAP - height);
    const left = Math.max(
      GAP,
      Math.min(caret.left, window.innerWidth - GAP - this.dom.offsetWidth),
    );
    this.dom.style.left = `${left}px`;
    this.dom.style.top = `${top}px`;
    elements[selected]?.scrollIntoView?.({ block: 'nearest' });
  }

  hide(): void {
    this.dom.remove();
  }
}
