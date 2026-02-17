import {
  ViewPlugin,
  PluginValue,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  ViewUpdate
} from '@codemirror/view';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';

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

  get estimatedHeight(): number {
    return 18; // 2px border + 8px margin top + 8px margin bottom
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
    // Wrap checkbox in a span for larger tap target
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-md-task-checkbox-wrapper';
    wrapper.style.cssText = `
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      min-height: 28px;
      margin-right: 4px;
      cursor: pointer;
      vertical-align: middle;
    `;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.checked;
    checkbox.className = 'cm-md-task-checkbox';
    checkbox.style.cssText = `
      width: 18px;
      height: 18px;
      cursor: pointer;
      margin: 0;
    `;

    // Make wrapper clicks toggle the checkbox
    wrapper.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.click();
      }
    });

    wrapper.appendChild(checkbox);
    return wrapper;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: any): boolean {
    return other instanceof TaskCheckboxWidget && other.checked === this.checked;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// Cache image dimensions to avoid layout shift on widget recreation
const imageSizeCache = new Map<string, { width: number; height: number }>();

// Cache resolved web URLs for local image filenames
const localImageUrlCache = new Map<string, string>();

// Max display width for images (matches CSS max-width: 100% within editor)
const MAX_IMAGE_HEIGHT = 300; // matches CSS max-height

/** Check if a src is a remote URL or data URI (not a local file reference). */
function isRemoteSrc(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:');
}

/** Resolve an image src to a displayable URL. Local filenames use the cache. */
export function resolveImageSrc(src: string): string {
  if (isRemoteSrc(src)) return src;
  return localImageUrlCache.get(src) ?? '';
}

/** Register a local image filename → web URL mapping so it renders immediately. */
export function registerLocalImageUrl(filename: string, webUrl: string): void {
  localImageUrlCache.set(filename, webUrl);
}

/**
 * Preload all images found in markdown text and cache their dimensions.
 * Call this when a note is opened so images are ready before the user scrolls.
 * For local image references, resolves them via getImageWebPath().
 */
export function preloadImages(markdownText: string, getImageWebPath?: (filename: string) => Promise<string>): void {
  const imageRegex = /!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;
  let match;
  while ((match = imageRegex.exec(markdownText)) !== null) {
    const src = match[1];

    // For local filenames, resolve to web URL first
    if (!isRemoteSrc(src)) {
      if (!localImageUrlCache.has(src) && getImageWebPath) {
        getImageWebPath(src).then(webUrl => {
          localImageUrlCache.set(src, webUrl);
          // Now preload the resolved URL for dimension caching
          preloadSingleImage(webUrl);
        }).catch(() => { /* file missing — ignore */ });
      } else if (localImageUrlCache.has(src)) {
        preloadSingleImage(localImageUrlCache.get(src)!);
      }
      continue;
    }

    preloadSingleImage(src);
  }
}

function preloadSingleImage(url: string): void {
  if (imageSizeCache.has(url)) return;
  const img = new Image();
  img.src = url;
  img.onload = () => {
    if (imageSizeCache.has(url)) return;
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (h > MAX_IMAGE_HEIGHT) {
      w = Math.round(w * (MAX_IMAGE_HEIGHT / h));
      h = MAX_IMAGE_HEIGHT;
    }
    imageSizeCache.set(url, { width: w, height: h });
  };
}

class ImageWidget extends WidgetType {
  constructor(private alt: string, private src: string) {
    super();
  }

  /** Resolve src: remote URLs pass through, local filenames use the cache. */
  private get resolvedSrc(): string {
    return resolveImageSrc(this.src);
  }

  get estimatedHeight(): number {
    const url = this.resolvedSrc || this.src;
    const cached = imageSizeCache.get(url);
    return cached ? cached.height : 200;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-image-wrapper';

    const displayUrl = this.resolvedSrc;
    const cached = displayUrl ? imageSizeCache.get(displayUrl) : undefined;
    if (cached) {
      wrapper.style.cssText = `height: ${cached.height}px;`;
    } else {
      wrapper.style.cssText = `min-height: 200px;`;
    }

    const img = document.createElement('img');
    img.alt = this.alt;
    img.className = 'cm-md-image-widget';

    if (displayUrl) {
      img.src = displayUrl;
    }
    // If no resolved URL yet (local file still loading), leave src empty — it'll render on next rebuild

    if (cached) {
      img.width = cached.width;
      img.height = cached.height;
    }

    img.onload = () => {
      const cacheKey = displayUrl || this.src;
      if (!imageSizeCache.has(cacheKey)) {
        const displayWidth = img.offsetWidth;
        const displayHeight = img.offsetHeight;
        imageSizeCache.set(cacheKey, { width: displayWidth, height: displayHeight });
      }
      // Always sync wrapper height to actual rendered size
      wrapper.style.cssText = `height: ${img.offsetHeight}px;`;
    };

    wrapper.appendChild(img);
    return wrapper;
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

  get estimatedHeight(): number {
    return 0;
  }

  eq(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  constructor(private indent: number = 0) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-bullet';
    span.textContent = '•';
    span.style.cssText = `margin-right: 8px; color: #666; margin-left: ${this.indent * 16}px;`;
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: any): boolean {
    return other instanceof BulletWidget && other.indent === this.indent;
  }
}

class NumberWidget extends WidgetType {
  constructor(private num: number, private indent: number = 0) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-number';
    span.textContent = `${this.num}.`;
    span.style.cssText = `margin-right: 8px; color: #666; font-weight: 500; margin-left: ${this.indent * 16}px;`;
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: any): boolean {
    return other instanceof NumberWidget && other.num === this.num && other.indent === this.indent;
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
  lastTreeLength: number = 0;
  compositionSuspended = false;

  constructor(view: EditorView) {
    // Force full parse so all decorations are present from the start,
    // preventing scroll jumps from height estimation mismatches
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);
    this.lastTreeLength = syntaxTree(view.state).length;
    this.decorations = this.buildDecorations(view);
  }

  update(update: ViewUpdate): void {
    // Android IME composition can conflict with heavy mark/replace decorations.
    // Temporarily suspend live transforms while composing to avoid crashes and
    // preserve native composition highlighting behavior.
    if (update.view.composing || update.view.compositionStarted) {
      if (!this.compositionSuspended) {
        this.decorations = Decoration.none;
        this.compositionSuspended = true;
      }
      return;
    }

    if (this.compositionSuspended) {
      this.compositionSuspended = false;
      this.decorations = this.buildDecorations(update.view);
      this.lastTreeLength = syntaxTree(update.state).length;
      return;
    }

    const tree = syntaxTree(update.state);
    const treeGrew = tree.length > this.lastTreeLength;

    if (treeGrew) {
      this.lastTreeLength = tree.length;
    }

    const shouldRebuild = update.docChanged || update.selectionSet || update.focusChanged || treeGrew;

    if (shouldRebuild) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  private buildDecorations(view: EditorView): DecorationSet {
    if (view.composing || view.compositionStarted) {
      return Decoration.none;
    }

    const decorations: Array<{ from: number; to: number; value: any }> = [];
    const cursorLines = this.getCursorLines(view);

    // Get syntax tree
    const tree = syntaxTree(view.state);

    // Iterate through full tree
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
        this.processElement(nodeName, from, to, view, decorations, cursorLines);
      }
    });

    // Sort decorations by from position, then by whether they are widgets at point (side)
    // Widgets with side:-1 come before widgets at same position
    const sorted = decorations.sort((a, b) => {
      if (a.from !== b.from) return a.from - b.from;
      // Point widgets with side:-1 should come first
      const aSide = a.value.side ?? 0;
      const bSide = b.value.side ?? 0;
      return aSide - bSide;
    });

    // Build decoration ranges
    const ranges: any[] = [];
    for (const d of sorted) {
      try {
        if (d.value.startSide !== undefined || d.value.endSide !== undefined) {
          // Line decoration
          ranges.push(Decoration.line(d.value).range(d.from));
        } else if (d.value.class !== undefined && d.value.widget === undefined) {
          // Mark decoration - skip if empty (from === to)
          if (d.from !== d.to) {
            ranges.push(Decoration.mark(d.value).range(d.from, d.to));
          }
        } else if (d.value.widget !== undefined && d.from === d.to) {
          // Widget at point - include side if specified
          const widgetSpec: any = { widget: d.value.widget };
          if (d.value.side !== undefined) widgetSpec.side = d.value.side;
          ranges.push(Decoration.widget(widgetSpec).range(d.from));
        } else if (d.value.widget !== undefined && d.from !== d.to) {
          // Replace decoration (hide text with widget)
          ranges.push(Decoration.replace({ widget: d.value.widget }).range(d.from, d.to));
        }
      } catch (e) {
        // Skip invalid decorations
        console.warn('Invalid decoration:', d, e);
      }
    }

    return Decoration.set(ranges, true);
  }

  private getCursorLines(view: EditorView): Set<number> {
    const lines = new Set<number>();
    if (!view.hasFocus) {
      return lines;
    }
    for (const range of view.state.selection.ranges) {
      const line = view.state.doc.lineAt(range.from).number;
      lines.add(line);
    }
    return lines;
  }

  private isBlockElement(nodeName: string): boolean {
    return /^(ATXHeading|ListItem|FencedCode|CodeBlock|HorizontalRule)/.test(
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
    decorations: Array<{ from: number; to: number; value: any }>,
    cursorLines: Set<number>
  ): void {
    const doc = view.state.doc;
    const text = doc.sliceString(from, to);

    if (MarkdownParser.isHeading(nodeName)) {
      this.processHeading(nodeName, from, to, text, decorations);
    } else if (MarkdownParser.isEmphasis(nodeName)) {
      this.processEmphasis(nodeName, from, to, text, decorations);
    } else if (MarkdownParser.isCode(nodeName)) {
      this.processCode(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isStrikethrough(nodeName)) {
      this.processStrikethrough(from, to, decorations);
    } else if (MarkdownParser.isLink(nodeName)) {
      this.processLink(from, to, text, decorations);
    } else if (MarkdownParser.isImage(nodeName)) {
      this.processImage(from, to, text, decorations);
    } else if (MarkdownParser.isBlockQuote(nodeName)) {
      this.processBlockQuote(from, to, view, decorations, cursorLines);
    } else if (MarkdownParser.isListItem(nodeName)) {
      this.processListItem(from, to, text, view, decorations);
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
      const markerLength = markerMatch[0].length;
      const hasSpace = text[markerLength] === ' ';
      const markerEnd = from + markerLength + (hasSpace ? 1 : 0);

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
    view: EditorView,
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
      // FencedCode or CodeBlock - apply line decorations for unified block
      const doc = view.state.doc;
      const startLine = doc.lineAt(from);
      const endLine = doc.lineAt(to);

      // Collect content lines (excluding fence lines)
      const contentLines: number[] = [];

      for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
        const line = doc.line(lineNum);
        const lineText = line.text;

        // First line: hide the opening fence (```lang) - allow indentation
        if (lineNum === startLine.number) {
          const fenceMatch = lineText.match(/^\s*(`{3,}|~{3,}).*$/);
          if (fenceMatch) {
            decorations.push({
              from: line.from,
              to: line.to,
              value: { widget: new HiddenWidget() }
            });
          }
        }
        // Last line: hide the closing fence (```) - allow indentation
        else if (lineNum === endLine.number) {
          const closingMatch = lineText.match(/^\s*(`{3,}|~{3,})\s*$/);
          if (closingMatch) {
            decorations.push({
              from: line.from,
              to: line.to,
              value: { widget: new HiddenWidget() }
            });
          }
        }
        // Content lines
        else {
          contentLines.push(lineNum);
        }
      }

      // Apply position-aware classes to content lines
      for (let i = 0; i < contentLines.length; i++) {
        const lineNum = contentLines[i];
        const line = doc.line(lineNum);

        let posClass = 'cm-md-code-block';
        if (contentLines.length === 1) {
          posClass += ' cm-md-code-block-single';
        } else if (i === 0) {
          posClass += ' cm-md-code-block-first';
        } else if (i === contentLines.length - 1) {
          posClass += ' cm-md-code-block-last';
        } else {
          posClass += ' cm-md-code-block-middle';
        }

        // Use line decoration for unified styling
        decorations.push({
          from: line.from,
          to: line.from,
          value: { class: posClass, startSide: 0, endSide: 0 }
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
    // Handle optional title: ![alt](url) or ![alt](url "title")
    const match = text.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/);
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
    decorations: Array<{ from: number; to: number; value: any }>,
    cursorLines: Set<number>
  ): void {
    const doc = view.state.doc;
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;

    // Collect all quote lines for position-aware styling
    const quoteLines: { lineNum: number; nestLevel: number }[] = [];

    for (let i = startLine; i <= endLine; i++) {
      const line = doc.line(i);
      const lineText = line.text;

      // Count nesting level and find content start
      let nestLevel = 0;
      let pos = 0;
      while (pos < lineText.length) {
        if (lineText[pos] === '>') {
          nestLevel++;
          pos++;
          // Skip optional space after >
          if (lineText[pos] === ' ') pos++;
        } else {
          break;
        }
      }

      if (nestLevel > 0) {
        if (pos > 0) {
          if (cursorLines.has(i)) {
            // Cursor on this line — show markers dimmed
            decorations.push({
              from: line.from,
              to: line.from + pos,
              value: { class: 'cm-md-quote-marker' }
            });
          } else {
            // Cursor not on this line — hide markers
            decorations.push({
              from: line.from,
              to: line.from + pos,
              value: { widget: new HiddenWidget() }
            });
          }
        }

        quoteLines.push({ lineNum: i, nestLevel });
      }
    }

    // Apply position-aware line decorations
    for (let i = 0; i < quoteLines.length; i++) {
      const { lineNum, nestLevel } = quoteLines[i];
      const line = doc.line(lineNum);

      let posClass = `cm-md-quote cm-md-quote-level-${nestLevel}`;
      if (quoteLines.length === 1) {
        posClass += ' cm-md-quote-single';
      } else if (i === 0) {
        posClass += ' cm-md-quote-first';
      } else if (i === quoteLines.length - 1) {
        posClass += ' cm-md-quote-last';
      } else {
        posClass += ' cm-md-quote-middle';
      }

      // Use line decoration
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: posClass, startSide: 0, endSide: 0 }
      });
    }
  }

  private processListItem(
    from: number,
    _to: number,
    text: string,
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const line = doc.lineAt(from);
    const lineEnd = line.to;

    // Check for unordered task first (checkbox syntax with bullet)
    const unorderedTaskMatch = text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*/);
    if (unorderedTaskMatch) {
      const indent = unorderedTaskMatch[1];
      const checked = unorderedTaskMatch[3];
      const indentLen = indent.length;
      const fullMarkerLen = unorderedTaskMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide bullet and checkbox syntax
      decorations.push({
        from: from + indentLen,
        to: contentStart,
        value: { widget: new HiddenWidget() }
      });

      // Add checkbox widget
      const checkbox = new TaskCheckboxWidget(checked === 'x' || checked === 'X');
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: checkbox,
          side: -1
        }
      });

      // Add className to content (not empty range)
      if (contentStart < lineEnd) {
        decorations.push({
          from: contentStart,
          to: lineEnd,
          value: { class: 'cm-md-task' }
        });
      }
      return;
    }

    // Check for ordered task (checkbox syntax with number)
    const orderedTaskMatch = text.match(/^(\s*)(\d+)\.\s+\[([ xX])\]\s*/);
    if (orderedTaskMatch) {
      const indentLen = orderedTaskMatch[1].length;
      const num = parseInt(orderedTaskMatch[2]);
      const checked = orderedTaskMatch[3];
      const indentLevel = Math.floor(indentLen / 2);
      const fullMarkerLen = orderedTaskMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide number, dot, and checkbox syntax
      decorations.push({
        from: from + indentLen,
        to: contentStart,
        value: { widget: new HiddenWidget() }
      });

      // Add number widget
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: new NumberWidget(num, indentLevel),
          side: -1
        }
      });

      // Add checkbox widget after number
      const checkbox = new TaskCheckboxWidget(checked === 'x' || checked === 'X');
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: checkbox,
          side: -1
        }
      });

      // Add className to content
      if (contentStart < lineEnd) {
        decorations.push({
          from: contentStart,
          to: lineEnd,
          value: { class: 'cm-md-task' }
        });
      }
      return;
    }

    // Regular unordered list
    const bulletMatch = text.match(/^(\s*)([-*+])\s+/);
    if (bulletMatch) {
      const indentLen = bulletMatch[1].length;
      const indentLevel = Math.floor(indentLen / 2);
      const fullMarkerLen = bulletMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide bullet and space
      decorations.push({
        from: from + indentLen,
        to: contentStart,
        value: { widget: new HiddenWidget() }
      });

      // Add bullet widget
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: new BulletWidget(indentLevel),
          side: -1
        }
      });

      // Add className to content
      if (contentStart < lineEnd) {
        decorations.push({
          from: contentStart,
          to: lineEnd,
          value: { class: 'cm-md-ul-item' }
        });
      }
      return;
    }

    // Ordered list
    const orderedMatch = text.match(/^(\s*)(\d+)\.\s+/);
    if (orderedMatch) {
      const indentLen = orderedMatch[1].length;
      const indentLevel = Math.floor(indentLen / 2);
      const num = parseInt(orderedMatch[2]);
      const fullMarkerLen = orderedMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide number, dot and space
      decorations.push({
        from: from + indentLen,
        to: contentStart,
        value: { widget: new HiddenWidget() }
      });

      // Add number widget
      decorations.push({
        from: from + indentLen,
        to: from + indentLen,
        value: {
          widget: new NumberWidget(num, indentLevel),
          side: -1
        }
      });

      // Add className to content
      if (contentStart < lineEnd) {
        decorations.push({
          from: contentStart,
          to: lineEnd,
          value: { class: 'cm-md-ol-item' }
        });
      }
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
