import Clusterize from 'clusterize.js';
import { NotePreview } from '../types';
import { escapeHtml } from '../lib/utils';

export interface VirtualListOptions {
  scrollElement: HTMLElement;
  contentElement: HTMLElement;
  rowHeight: number;
  onItemClick?: (id: string) => void;
  showPreview?: boolean;
}

export class VirtualList {
  private clusterize: Clusterize;
  private items: NotePreview[] = [];
  private selectedId: string | null = null;
  private scrollElement: HTMLElement;
  private contentElement: HTMLElement;
  private rowHeight: number;
  private onItemClick?: (id: string) => void;
  private showPreview: boolean;

  constructor(options: VirtualListOptions) {
    this.scrollElement = options.scrollElement;
    this.contentElement = options.contentElement;
    this.rowHeight = options.rowHeight;
    this.onItemClick = options.onItemClick;
    this.showPreview = options.showPreview ?? false;

    // Apply required classes
    this.scrollElement.classList.add('clusterize-scroll');
    this.contentElement.classList.add('clusterize-content');

    this.clusterize = new Clusterize({
      scrollElem: this.scrollElement,
      contentElem: this.contentElement,
      rows: [],
      show_no_data_row: true,
      no_data_text: '<div class="empty">No notes yet. Tap + to create one.</div>',
      no_data_class: 'clusterize-no-data'
    });

    // Event delegation for clicks
    this.contentElement.addEventListener('click', this.handleClick.bind(this));
  }

  private handleClick(event: Event): void {
    const target = event.target as HTMLElement;
    const noteItem = target.closest('.note-item') as HTMLElement | null;
    if (noteItem && this.onItemClick) {
      const id = noteItem.dataset.id;
      if (id) {
        this.onItemClick(id);
      }
    }
  }

  private renderRow(note: NotePreview): string {
    const isSelected = note.id === this.selectedId;
    const selectedClass = isSelected ? ' selected' : '';

    if (this.showPreview) {
      return `
        <div class="note-item${selectedClass}" data-id="${note.id}" style="height: ${this.rowHeight}px;">
          <div class="note-content">
            <div class="note-title">${escapeHtml(note.title)}</div>
            <div class="note-preview">${escapeHtml(note.preview)}</div>
          </div>
        </div>
      `.trim();
    } else {
      return `
        <div class="note-item${selectedClass}" data-id="${note.id}" style="height: ${this.rowHeight}px;">
          <div class="note-title">${escapeHtml(note.title)}</div>
        </div>
      `.trim();
    }
  }

  update(items: NotePreview[]): void {
    this.items = items;
    const rows = items.map(item => this.renderRow(item));
    this.clusterize.update(rows);
  }

  setSelected(id: string | null): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    // Re-render with new selection
    const rows = this.items.map(item => this.renderRow(item));
    this.clusterize.update(rows);
  }

  getSelected(): string | null {
    return this.selectedId;
  }

  refresh(): void {
    this.clusterize.refresh();
  }

  destroy(): void {
    this.contentElement.removeEventListener('click', this.handleClick.bind(this));
    this.clusterize.destroy(true);
  }

  getScrollProgress(): number {
    return this.clusterize.getScrollProgress();
  }

  getItemCount(): number {
    return this.items.length;
  }
}
