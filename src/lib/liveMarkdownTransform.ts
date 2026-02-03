import {
  ViewPlugin,
  PluginValue,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  ViewUpdate
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';

// Widget Classes
class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('div');
    hr.className = 'cm-md-hr-widget';
    const line = document.createElement('div');
    line.style.cssText = `
      border-top: 2px solid #ccc;
      margin: 8px 0;
      opacity: 0.5;
    `;
    hr.appendChild(line);
    return hr;
  }

  eq(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TaskCheckboxWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }

  toDOM(): HTMLElement {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.checked;
    checkbox.className = 'cm-md-task-checkbox';
    checkbox.style.cssText = 'margin-right: 6px; cursor: pointer;';
    return checkbox;
  }

  eq(other: any): boolean {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TableWidget extends WidgetType {
  constructor(private rows: string[][]) {
    super();
  }

  toDOM(): HTMLElement {
    const table = document.createElement('table');
    table.className = 'cm-md-table-widget';
    table.style.cssText = `
      border-collapse: collapse;
      width: 100%;
      margin: 8px 0;
      border: 1px solid #ddd;
      font-size: 0.95em;
    `;

    this.rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const td = document.createElement('td');
        td.textContent = cell;
        td.style.cssText = `
          padding: 8px;
          border: 1px solid #ddd;
          text-align: left;
        `;
        if (rowIdx === 0) {
          td.style.fontWeight = 'bold';
          td.style.backgroundColor = '#f5f5f5';
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });

    return table;
  }

  eq(other: any): boolean {
    return other instanceof TableWidget && JSON.stringify(other.rows) === JSON.stringify(this.rows);
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class ImageWidget extends WidgetType {
  constructor(private alt: string, private src: string) {
    super();
  }

  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.alt = this.alt;
    img.src = this.src;
    img.className = 'cm-md-image-widget';
    img.style.cssText = `
      max-width: 100%;
      max-height: 300px;
      margin: 8px 0;
      border-radius: 4px;
    `;
    return img;
  }

  eq(other: any): boolean {
    return other instanceof ImageWidget && other.src === this.src;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class HiddenWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.style.display = 'none';
    return span;
  }

  eq(): boolean {
    return true;
  }
}

// Parser utilities
class MarkdownParser {
  static isHeading(nodeName: string): boolean {
    return /^ATXHeading[1-6]$/.test(nodeName);
  }

  static getHeadingLevel(nodeName: string): number {
    const match = nodeName.match(/ATXHeading(\d)/);
    return match ? parseInt(match[1]) : 0;
  }

  static isEmphasis(nodeName: string): boolean {
    return nodeName === 'Emphasis' || nodeName === 'StrongEmphasis';
  }

  static isCode(nodeName: string): boolean {
    return nodeName === 'InlineCode' || nodeName === 'CodeBlock' || nodeName === 'FencedCode';
  }

  static isLink(nodeName: string): boolean {
    return nodeName === 'Link';
  }

  static isImage(nodeName: string): boolean {
    return nodeName === 'Image';
  }

  static isListItem(nodeName: string): boolean {
    return nodeName === 'ListItem';
  }

  static isBlockQuote(nodeName: string): boolean {
    return nodeName === 'Blockquote';
  }

  static isTable(nodeName: string): boolean {
    return nodeName === 'Table';
  }

  static isStrikethrough(nodeName: string): boolean {
    return nodeName === 'Strikethrough';
  }

  static isTask(nodeName: string): boolean {
    return nodeName === 'Task';
  }

  static isHorizontalRule(nodeName: string): boolean {
    return nodeName === 'HorizontalRule';
  }
}

// Main Plugin
class LiveMarkdownPlugin implements PluginValue {
  decorations: DecorationSet = Decoration.none;

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.focusChanged
    ) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  private buildDecorations(view: EditorView): DecorationSet {
    const decorations: Array<{ from: number; to: number; value: any }> = [];
    const cursorLines = this.getCursorLines(view);

    // Get syntax tree
    const tree = syntaxTree(view.state);

    // Iterate through tree
    tree.iterate({
      enter: (node) => {
        const nodeName = node.name;
        const from = node.from;
        const to = node.to;
        const line = view.state.doc.lineAt(from).number;

        // Skip if cursor is in this line for block elements
        if (
          this.isBlockElement(nodeName) &&
          cursorLines.has(line)
        ) {
          return;
        }

        // Skip if cursor is inside this element
        if (
          this.isInlineElement(nodeName) &&
          this.isCursorInside(view, from, to)
        ) {
          return;
        }

        // Process element
        this.processElement(nodeName, from, to, view, decorations);
      }
    });

    // Convert to Decoration.set format
    const built: Array<{ from: number; to: number; value: any }> = [];
    for (const dec of decorations.sort((a, b) => a.from - b.from)) {
      built.push(dec);
    }

    return Decoration.set(
      built.map((d) => {
        if (d.value.startSide !== undefined || d.value.endSide !== undefined) {
          // Line decoration
          return Decoration.line(d.value).range(d.from);
        } else if (d.value.class !== undefined && d.value.widget === undefined) {
          // Mark decoration
          return Decoration.mark(d.value).range(d.from, d.to);
        } else if (d.value.widget !== undefined && d.from === d.to) {
          // Widget at point
          return Decoration.widget(d.value.widget).range(d.from);
        } else if (d.value.widget !== undefined) {
          // Replace decoration (hide text with widget)
          return Decoration.replace({ widget: d.value.widget }).range(d.from, d.to);
        }
        return undefined;
      }).filter(Boolean) as any
    );
  }

  private getCursorLines(view: EditorView): Set<number> {
    const lines = new Set<number>();
    for (const range of view.state.selection.ranges) {
      const line = view.state.doc.lineAt(range.from).number;
      lines.add(line);
    }
    return lines;
  }

  private isBlockElement(nodeName: string): boolean {
    return /^(ATXHeading|Blockquote|ListItem|FencedCode|CodeBlock|Table|HorizontalRule)/.test(
      nodeName
    );
  }

  private isInlineElement(nodeName: string): boolean {
    return /^(Emphasis|StrongEmphasis|InlineCode|Link|Image|Strikethrough|Task)/.test(nodeName);
  }

  private isCursorInside(view: EditorView, from: number, to: number): boolean {
    for (const range of view.state.selection.ranges) {
      if (range.from >= from && range.from <= to) return true;
      if (range.to >= from && range.to <= to) return true;
    }
    return false;
  }

  private processElement(
    nodeName: string,
    from: number,
    to: number,
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const text = doc.sliceString(from, to);

    if (MarkdownParser.isHeading(nodeName)) {
      this.processHeading(nodeName, from, to, text, decorations);
    } else if (MarkdownParser.isEmphasis(nodeName)) {
      this.processEmphasis(nodeName, from, to, text, decorations);
    } else if (MarkdownParser.isCode(nodeName)) {
      this.processCode(nodeName, from, to, text, decorations);
    } else if (MarkdownParser.isStrikethrough(nodeName)) {
      this.processStrikethrough(from, to, decorations);
    } else if (MarkdownParser.isLink(nodeName)) {
      this.processLink(from, to, text, decorations);
    } else if (MarkdownParser.isImage(nodeName)) {
      this.processImage(from, to, text, decorations);
    } else if (MarkdownParser.isBlockQuote(nodeName)) {
      this.processBlockQuote(from, to, view, decorations);
    } else if (MarkdownParser.isListItem(nodeName)) {
      this.processListItem(from, to, text, view, decorations);
    } else if (MarkdownParser.isTable(nodeName)) {
      this.processTable(from, to, text, decorations);
    } else if (MarkdownParser.isHorizontalRule(nodeName)) {
      this.processHorizontalRule(from, to, decorations);
    }
  }

  private processHeading(
    nodeName: string,
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const level = MarkdownParser.getHeadingLevel(nodeName);
    const markerMatch = text.match(/^#+/);

    if (markerMatch) {
      const markerEnd = from + markerMatch[0].length;

      // Hide markdown markers
      decorations.push({
        from,
        to: markerEnd,
        value: { widget: new HiddenWidget() }
      });

      // Add className to content (from marker end to end of line)
      decorations.push({
        from: markerEnd,
        to: to,
        value: {
          class: `cm-md-h${level}`,
          attributes: { 'data-heading-level': level.toString() }
        }
      });
    }
  }

  private processEmphasis(
    nodeName: string,
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const isStrong = nodeName === 'StrongEmphasis';
    const cssClass = isStrong ? 'cm-md-strong' : 'cm-md-emphasis';
    const markerLength = isStrong ? 2 : 1;

    if (text.length >= markerLength * 2) {
      // Hide start marker
      decorations.push({
        from,
        to: from + markerLength,
        value: { widget: new HiddenWidget() }
      });

      // Hide end marker
      decorations.push({
        from: to - markerLength,
        to,
        value: { widget: new HiddenWidget() }
      });

      // Add className to content
      decorations.push({
        from: from + markerLength,
        to: to - markerLength,
        value: { class: cssClass }
      });
    }
  }

  private processCode(
    nodeName: string,
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    if (nodeName === 'InlineCode') {
      const backticks = text.match(/^`+/)?.[0].length ?? 1;

      // Hide start backticks
      decorations.push({
        from,
        to: from + backticks,
        value: { widget: new HiddenWidget() }
      });

      // Hide end backticks
      decorations.push({
        from: to - backticks,
        to,
        value: { widget: new HiddenWidget() }
      });

      // Add className
      decorations.push({
        from,
        to,
        value: { class: 'cm-md-code' }
      });
    } else {
      // FencedCode or CodeBlock
      const fenceMatch = text.match(/^(`{3,}|~{3,})/);
      if (fenceMatch) {
        const fenceLength = fenceMatch[0].length;
        const afterFence = text.substring(fenceLength);
        const langEnd = afterFence.indexOf('\n');
        const language = langEnd >= 0 ? afterFence.substring(0, langEnd) : afterFence;

        // Hide opening fence and language specifier
        decorations.push({
          from,
          to: from + fenceLength + language.length + 1,
          value: { widget: new HiddenWidget() }
        });

        // Hide closing fence
        const closingMatch = text.substring(text.length - 10).match(/(`{3,}|~{3,})$/);
        if (closingMatch) {
          decorations.push({
            from: to - closingMatch[0].length,
            to,
            value: { widget: new HiddenWidget() }
          });
        }

        // Add className
        decorations.push({
          from,
          to,
          value: { class: 'cm-md-code-block' }
        });
      }
    }
  }

  private processStrikethrough(
    from: number,
    to: number,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Hide start ~~
    decorations.push({
      from,
      to: from + 2,
      value: { widget: new HiddenWidget() }
    });

    // Hide end ~~
    decorations.push({
      from: to - 2,
      to,
      value: { widget: new HiddenWidget() }
    });

    // Add className
    decorations.push({
      from: from + 2,
      to: to - 2,
      value: { class: 'cm-md-strikethrough' }
    });
  }

  private processLink(
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const match = text.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
    if (match) {
      const linkText = match[1];
      const textStart = from + 1;
      const textEnd = textStart + linkText.length;

      // Hide opening bracket
      decorations.push({
        from,
        to: from + 1,
        value: { widget: new HiddenWidget() }
      });

      // Hide closing bracket and URL
      decorations.push({
        from: textEnd,
        to,
        value: { widget: new HiddenWidget() }
      });

      // Add className to link text
      decorations.push({
        from: textStart,
        to: textEnd,
        value: { class: 'cm-md-link' }
      });
    }
  }

  private processImage(
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const match = text.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (match) {
      const alt = match[1];
      const url = match[2];

      decorations.push({
        from,
        to,
        value: { widget: new ImageWidget(alt, url) }
      });
    }
  }

  private processBlockQuote(
    from: number,
    to: number,
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;

    for (let i = startLine; i <= endLine; i++) {
      const line = doc.line(i);
      if (line.text.startsWith('>')) {
        // Hide the > marker
        decorations.push({
          from: line.from,
          to: line.from + 1,
          value: { widget: new HiddenWidget() }
        });

        // Hide optional space after >
        if (line.text[1] === ' ') {
          decorations.push({
            from: line.from + 1,
            to: line.from + 2,
            value: { widget: new HiddenWidget() }
          });
        }

        // Add className
        decorations.push({
          from: line.from,
          to: line.from,
          value: { class: 'cm-md-quote' }
        });
      }
    }
  }

  private processListItem(
    from: number,
    _to: number,
    text: string,
    _view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Check for task first (checkbox syntax)
    const taskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX])\]/);
    if (taskMatch) {
      const indent = taskMatch[1];
      const bullet = taskMatch[2];
      const checked = taskMatch[3];
      const indentLen = indent.length;
      const bulletEnd = indentLen + bullet.length + 4;

      // Hide bullet and checkbox
      decorations.push({
        from: from + indentLen,
        to: from + bulletEnd,
        value: { widget: new HiddenWidget() }
      });

      // Add checkbox widget
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: new TaskCheckboxWidget(checked === 'x' || checked === 'X'),
          side: -1
        }
      });

      // Add className
      decorations.push({
        from,
        to: from,
        value: { class: 'cm-md-task' }
      });
      return;
    }

    // Regular unordered list
    const bulletMatch = text.match(/^(\s*)([-*+])\s+/);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      const bullet = bulletMatch[2];
      const indentLen = indent.length;
      const markerEnd = indentLen + 1 + (text[indentLen + 1] === ' ' ? 1 : 0);

      // Hide bullet
      decorations.push({
        from: from + indentLen,
        to: from + markerEnd,
        value: { widget: new HiddenWidget() }
      });

      // Add className
      decorations.push({
        from,
        to: from,
        value: {
          class: 'cm-md-ul-item',
          attributes: { 'data-bullet': bullet }
        }
      });
      return;
    }

    // Ordered list
    const orderedMatch = text.match(/^(\s*)(\d+)\.\s+/);
    if (orderedMatch) {
      const indent = orderedMatch[1];
      const number = orderedMatch[2];
      const indentLen = indent.length;
      const numberLen = number.length;
      const markerEnd = indentLen + numberLen + 2 + (text[indentLen + numberLen + 2] === ' ' ? 1 : 0);

      // Hide dot and space after number
      decorations.push({
        from: from + indentLen + numberLen,
        to: from + markerEnd,
        value: { widget: new HiddenWidget() }
      });

      // Add className
      decorations.push({
        from,
        to: from,
        value: {
          class: 'cm-md-ol-item',
          attributes: { 'data-number': number }
        }
      });
    }
  }

  private processTable(
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Simple table parsing
    const rows = text
      .split('\n')
      .filter((line) => line.includes('|'))
      .map((line) =>
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim())
      );

    if (rows.length > 0) {
      decorations.push({
        from,
        to,
        value: { widget: new TableWidget(rows) }
      });
    }
  }

  private processHorizontalRule(
    from: number,
    to: number,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    decorations.push({
      from,
      to,
      value: { widget: new HorizontalRuleWidget() }
    });
  }
}

export const liveMarkdownTransform = ViewPlugin.fromClass(LiveMarkdownPlugin, {
  decorations: (v) => v.decorations
});
