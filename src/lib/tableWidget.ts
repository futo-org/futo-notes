import { WidgetType, EditorView } from '@codemirror/view';
import { openUrl } from '$lib/openUrl';

export interface TableCell {
  content: string;
  align: 'left' | 'center' | 'right';
}

export interface ParsedTable {
  headers: TableCell[];
  rows: TableCell[][];
  alignments: ('left' | 'center' | 'right')[];
}

/**
 * Parses a markdown table string into structured data
 */
export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter(line => line.trim());

  if (lines.length < 2) return null;

  // Parse header row
  const headerLine = lines[0];
  const headers = parseCells(headerLine);
  if (headers.length === 0) return null;

  // Parse alignment row (second line)
  const alignLine = lines[1];
  if (!isAlignmentRow(alignLine)) return null;
  const alignments = parseAlignments(alignLine);

  // Ensure alignment count matches header count
  while (alignments.length < headers.length) {
    alignments.push('left');
  }

  // Apply alignments to headers
  const headerCells: TableCell[] = headers.map((content, i) => ({
    content,
    align: alignments[i] || 'left'
  }));

  // Parse data rows
  const rows: TableCell[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = parseCells(lines[i]);
    const rowCells: TableCell[] = [];

    for (let j = 0; j < headers.length; j++) {
      rowCells.push({
        content: cells[j] || '',
        align: alignments[j] || 'left'
      });
    }

    rows.push(rowCells);
  }

  return { headers: headerCells, rows, alignments };
}

function parseCells(line: string): string[] {
  // Remove leading/trailing pipes
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  // Split on unescaped pipes only
  // Replace escaped pipes with a placeholder, split, then restore
  const placeholder = '\x00PIPE\x00';
  const withPlaceholder = trimmed.replace(/\\\|/g, placeholder);
  const cells = withPlaceholder.split('|');

  return cells.map(cell => cell.replace(new RegExp(placeholder, 'g'), '|').trim());
}

function isAlignmentRow(line: string): boolean {
  // Match rows containing only |, -, :, and whitespace
  return /^\|?[\s\-:|]+\|?$/.test(line.trim());
}

function parseAlignments(line: string): ('left' | 'center' | 'right')[] {
  const cells = parseCells(line);
  return cells.map(cell => {
    const trimmed = cell.trim();
    const hasLeft = trimmed.startsWith(':');
    const hasRight = trimmed.endsWith(':');

    if (hasLeft && hasRight) return 'center';
    if (hasRight) return 'right';
    return 'left';
  });
}

/**
 * Escapes HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Blocks dangerous URL schemes (javascript:, data:, vbscript:) while allowing
 * all others including custom deep link schemes (stonefruit://, obsidian://, etc.).
 * Must decode HTML entities before checking since escapeHtml runs first.
 */
export function sanitizeUrl(url: string): string {
  // Decode HTML entities for scheme check
  const decoded = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#47;/g, '/');
  const trimmed = decoded.replace(/[\s\x00-\x1f]+/g, '').toLowerCase();
  if (/^(javascript|data|vbscript)\s*:/i.test(trimmed)) return '';
  return url;
}

/**
 * Renders inline markdown to HTML
 * Supports: bold, italic, code, strikethrough, links
 */
function renderInlineMarkdown(text: string): string {
  // First escape HTML to prevent XSS
  let html = escapeHtml(text);

  // Process inline code first (to prevent other formatting inside code)
  // Match `code` but not escaped backticks
  html = html.replace(/`([^`]+)`/g, '<code class="cm-md-table-code">$1</code>');

  // Bold: **text** or __text__
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');

  // Italic: *text* or _text_ (but not inside words for underscore)
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, '<em>$1</em>');

  // Strikethrough: ~~text~~
  html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Links: [text](url) — blocked schemes render as plain text
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText, href) => {
      const safe = sanitizeUrl(href);
      if (!safe) return linkText;
      return `<a href="${safe}" class="cm-md-table-link" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    }
  );

  return html;
}

/**
 * Widget that renders a markdown table as styled HTML
 */
export class TableWidget extends WidgetType {
  private table: ParsedTable;
  private tableFrom: number;
  private sourceText: string;

  constructor(text: string, from: number, _to: number) {
    super();
    this.sourceText = text;
    this.table = parseMarkdownTable(text) || { headers: [], rows: [], alignments: [] };
    this.tableFrom = from;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-table-wrapper';

    const table = document.createElement('table');
    table.className = 'cm-md-table-rendered';

    // Create header
    if (this.table.headers.length > 0) {
      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');

      for (const cell of this.table.headers) {
        const th = document.createElement('th');
        th.innerHTML = renderInlineMarkdown(cell.content);
        th.style.textAlign = cell.align;
        headerRow.appendChild(th);
      }

      thead.appendChild(headerRow);
      table.appendChild(thead);
    }

    // Create body
    if (this.table.rows.length > 0) {
      const tbody = document.createElement('tbody');

      for (const row of this.table.rows) {
        const tr = document.createElement('tr');

        for (const cell of row) {
          const td = document.createElement('td');
          td.innerHTML = renderInlineMarkdown(cell.content);
          td.style.textAlign = cell.align;
          tr.appendChild(td);
        }

        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
    }

    wrapper.appendChild(table);

    // Track touch to distinguish taps from scrolls
    // Don't interfere with browser's native scroll - just detect tap vs scroll
    let touchStartX = 0;
    let touchStartY = 0;
    let didScroll = false;

    wrapper.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        didScroll = false;
      }
      // Don't stop propagation - let browser handle scroll setup
    }, { passive: true });

    wrapper.addEventListener('touchmove', (e) => {
      if (e.touches.length === 1) {
        const dx = Math.abs(e.touches[0].clientX - touchStartX);
        const dy = Math.abs(e.touches[0].clientY - touchStartY);
        // If moved more than 10px in any direction, it's a scroll
        if (dx > 10 || dy > 10) {
          didScroll = true;
        }
      }
      // Don't stop propagation - let browser handle scrolling
    }, { passive: true });

    wrapper.addEventListener('touchend', (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('a.cm-md-table-link')) {
        return;
      }
      // Only enter edit mode if it was a tap (no scroll movement)
      if (!didScroll) {
        view.dispatch({
          selection: { anchor: this.tableFrom }
        });
        view.focus();
      }
    }, { passive: true });

    // Mouse click handler (for non-touch devices)
    wrapper.addEventListener('click', (e) => {
      // Ignore if this came from touch
      if (e.detail === 0) return;

      const target = e.target as HTMLElement | null;
      const link = target?.closest('a.cm-md-table-link') as HTMLAnchorElement | null;
      if (link) {
        e.preventDefault();
        openUrl(link.href);
        return;
      }

      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.tableFrom }
      });
      view.focus();
    });

    return wrapper;
  }

  eq(other: TableWidget): boolean {
    return other instanceof TableWidget && this.sourceText === other.sourceText;
  }

  get estimatedHeight(): number {
    // Estimate height based on number of rows
    // Header: ~40px, each row: ~36px, wrapper padding: ~16px
    const headerHeight = 40;
    const rowHeight = 36;
    const padding = 16;
    return headerHeight + (this.table.rows.length * rowHeight) + padding;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
