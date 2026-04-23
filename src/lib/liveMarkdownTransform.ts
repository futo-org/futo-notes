import {
  ViewPlugin,
  PluginValue,
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  ViewUpdate
} from '@codemirror/view';
import { StateEffect, type Text } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import { TAG_REGEX } from '@futo-notes/shared';

export const imageCacheUpdated = StateEffect.define<null>();
export const liveMarkdownRefresh = StateEffect.define<null>();

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

    // Prevent mousedown from focusing the contenteditable editor
    wrapper.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });

    function toggleCheckbox(): void {
      const editorEl = wrapper.closest('.cm-editor') as HTMLElement | null;
      if (!editorEl) return;
      const view = EditorView.findFromDOM(editorEl);
      if (!view) return;
      const hadFocus = view.hasFocus;
      const pos = view.posAtDOM(wrapper);
      const line = view.state.doc.lineAt(pos);
      const match = line.text.match(/\[([ xX])\]/);
      if (!match || match.index === undefined) return;
      const charPos = line.from + match.index + 1;
      const newChar = match[1] === ' ' ? 'x' : ' ';
      view.dispatch({ changes: { from: charPos, to: charPos + 1, insert: newChar }, selection: view.state.selection });
      // If editor wasn't focused before, don't let the dispatch steal focus
      if (!hadFocus) {
        view.contentDOM.blur();
      }
    }

    // Handle toggle via click on either checkbox or wrapper
    wrapper.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCheckbox();
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
    return true;
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

/** Matches a line that consists only of tags and whitespace (header tag block detection). */
const TAG_LINE_RE = /^\s*#[a-zA-Z][a-zA-Z0-9_-]{0,49}(\s+#[a-zA-Z][a-zA-Z0-9_-]{0,49})*\s*$/;

const IMAGE_REGEX = /!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g;

/**
 * Preload all images found in markdown text and cache their dimensions.
 * Call this when a note is opened so images are ready before the user scrolls.
 * For local image references, resolves them via getImageWebPath().
 */
export function preloadImages(
  markdownText: string,
  getImageWebPath?: (filename: string) => Promise<string>,
  getView?: () => EditorView | null
): void {
  // Fast-path: skip regex scan entirely if there's no image syntax
  if (!markdownText.includes('![')) return;
  IMAGE_REGEX.lastIndex = 0;
  let match;
  while ((match = IMAGE_REGEX.exec(markdownText)) !== null) {
    const src = match[1];

    // For local filenames, resolve to web URL first
    if (!isRemoteSrc(src)) {
      if (!localImageUrlCache.has(src) && getImageWebPath) {
        getImageWebPath(src).then(webUrl => {
          localImageUrlCache.set(src, webUrl);
          // Now preload the resolved URL for dimension caching
          preloadSingleImage(webUrl);
          const v = getView?.();
          if (v) {
            v.dispatch({ effects: imageCacheUpdated.of(null) });
          }
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
  private resolvedAtConstruction: string;

  constructor(private alt: string, private src: string, private endPos: number) {
    super();
    this.resolvedAtConstruction = resolveImageSrc(src);
  }

  get estimatedHeight(): number {
    const url = this.resolvedAtConstruction || this.src;
    const cached = imageSizeCache.get(url);
    return cached ? cached.height : 200;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'cm-md-image-wrapper';

    const displayUrl = this.resolvedAtConstruction;
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

    // Tap on image → place cursor at end of the image line
    wrapper.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const endPos = Math.min(this.endPos, view.state.doc.length);
      const line = view.state.doc.lineAt(endPos);
      view.dispatch({ selection: { anchor: line.to } });
      view.focus();
    });

    wrapper.appendChild(img);
    return wrapper;
  }

  eq(other: any): boolean {
    return other instanceof ImageWidget &&
      other.src === this.src &&
      other.resolvedAtConstruction === this.resolvedAtConstruction;
  }

  ignoreEvent(): boolean {
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
    const glyphs = ['•', '◦', '▪'];
    span.textContent = glyphs[this.indent % 3];
    span.style.cssText = `margin-right: 8px; color: #666;`;
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
    span.style.cssText = `margin-right: 8px; color: #666; font-weight: 500;`;
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: any): boolean {
    return other instanceof NumberWidget && other.num === this.num && other.indent === this.indent;
  }
}

// Hanging indent constants (pixels)
const INDENT_STEP = 24;   // extra indent per nesting level
const BULLET_MARKER_W = 20;  // bullet "•" + margin-right
const NUMBER_MARKER_W = 24;  // "N." + margin-right
const CHECKBOX_MARKER_W = 32; // checkbox wrapper + margin-right
const ORDERED_TASK_MARKER_W = 56; // number widget + checkbox widget

interface SelectionRangeLike {
  from: number;
  to: number;
}

interface LineNumberLookup {
  lineAt(pos: number): { number: number };
}

export function getCursorLinesForReveal(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  doc: LineNumberLookup
): Set<number> {
  const lines = new Set<number>();
  if (!hasFocus) return lines;
  for (const range of ranges) {
    lines.add(doc.lineAt(range.from).number);
  }
  return lines;
}

export function isBlockRevealSensitive(nodeName: string): boolean {
  return /^(ATXHeading|ListItem|FencedCode|CodeBlock|HorizontalRule)/.test(nodeName);
}

export function isInlineRevealSensitive(nodeName: string): boolean {
  return /^(Link|Image|Task)/.test(nodeName);
}

export function selectionTouchesRange(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number
): boolean {
  if (!hasFocus) return false;
  for (const range of ranges) {
    if (range.from === range.to) {
      // Treat a caret at the exact end of inline markdown as touching the range
      // so hidden closing markers are revealed and the cursor remains visible.
      if (range.from >= from && range.from <= to) return true;
      continue;
    }
    if (range.from < to && range.to > from) return true;
  }
  return false;
}

export function shouldRevealInlineMarkers(
  view: EditorView,
  from: number,
  to: number
): boolean {
  return selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);
}

export function shouldSkipBlockDecorations(
  nodeName: string,
  line: number,
  cursorLines: Set<number>
): boolean {
  return isBlockRevealSensitive(nodeName) && cursorLines.has(line);
}

export function shouldSkipInlineDecorations(
  nodeName: string,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[]
): boolean {
  return isInlineRevealSensitive(nodeName) && selectionTouchesRange(hasFocus, ranges, from, to);
}

export function shouldHideHeaderTagBlock(
  blockLastLine: number,
  cursorLines: Set<number>
): boolean {
  for (let line = 1; line <= blockLastLine; line += 1) {
    if (cursorLines.has(line)) return false;
  }
  return true;
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
  lastCursorLine: number = -1;
  lastCursorPos: number = -1;
  compositionSuspended = false;
  pendingRefresh: ReturnType<typeof setTimeout> | null = null;
  destroyed = false;
  private cachedHeaderDoc: Text | null = null;
  private cachedHeaderEndOffset: number = 0;

  constructor(view: EditorView) {
    // Force full parse so all decorations are present from the start,
    // preventing scroll jumps from height estimation mismatches
    ensureSyntaxTree(view.state, view.state.doc.length, 200);
    this.lastTreeLength = syntaxTree(view.state).length;
    this.decorations = this.buildDecorations(view);
    this.lastCursorPos = view.state.selection.main.head;
    this.lastCursorLine = view.state.doc.lineAt(this.lastCursorPos).number;
    this.scheduleParseRefresh(view);
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
      this.lastCursorPos = update.state.selection.main.head;
      this.lastCursorLine = update.state.doc.lineAt(this.lastCursorPos).number;
      return;
    }

    const tree = syntaxTree(update.state);
    const treeGrew = tree.length > this.lastTreeLength;
    const imageCacheChanged = update.transactions.some(
      (tr) => tr.effects.some((e) => e.is(imageCacheUpdated))
    );
    const refreshRequested = update.transactions.some(
      (tr) => tr.effects.some((e) => e.is(liveMarkdownRefresh))
    );

    if (treeGrew) {
      this.lastTreeLength = tree.length;
    }

    // Only treat selectionSet as needing rebuild when the cursor's line changed,
    // not on every keystroke (cursor moves within same line during typing)
    let cursorLineChanged = false;
    let selectionMovedWithinLine = false;
    if (update.selectionSet) {
      const curPos = update.state.selection.main.head;
      const curLine = update.state.doc.lineAt(curPos).number;
      if (curLine !== this.lastCursorLine) {
        this.lastCursorLine = curLine;
        cursorLineChanged = true;
      } else if (!update.docChanged && curPos !== this.lastCursorPos) {
        selectionMovedWithinLine = true;
      }
      this.lastCursorPos = curPos;
    }

    const shouldRebuild = update.docChanged ||
      cursorLineChanged ||
      selectionMovedWithinLine ||
      update.focusChanged ||
      treeGrew ||
      imageCacheChanged ||
      refreshRequested;

    if (shouldRebuild) {
      this.decorations = this.buildDecorations(update.view);
      this.scheduleParseRefresh(update.view);
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.pendingRefresh !== null) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = null;
    }
  }

  private buildDecorations(view: EditorView): DecorationSet {
    if (view.composing || view.compositionStarted) {
      return Decoration.none;
    }

    const decorations: Array<{ from: number; to: number; value: any }> = [];
    const cursorLines = this.getCursorLines(view);

    // Compute header tag block offset for skipping overlapping decorations
    const headerEndOffset = this.getHeaderEndOffset(view.state.doc);

    // Get syntax tree
    const tree = syntaxTree(view.state);

    // Iterate through full tree
    tree.iterate({
      enter: (node) => {
        const nodeName = node.name;
        const from = node.from;
        const to = node.to;

        // Skip syntax nodes within the header tag block to avoid overlapping decorations
        if (headerEndOffset > 0 && from < headerEndOffset) return;

        const line = view.state.doc.lineAt(from).number;

        // Skip if cursor is in this line for block elements
        if (this.isBlockElement(nodeName) && cursorLines.has(line)) {
          // For ListItem on cursor lines, still apply indent padding
          // so indentation doesn't visually jump when cursor enters/leaves
          if (nodeName === 'ListItem') {
            this.processListItemIndentOnly(from, view, decorations);
          }
          return;
        }

        // Skip if cursor is inside this element
        if (this.isInlineElement(nodeName) && this.isCursorInside(view, from, to)) {
          return;
        }

        // Process element
        this.processElement(nodeName, from, to, view, decorations, cursorLines);
      }
    });

    // Process wikilinks (not part of markdown syntax tree)
    this.processWikilinks(view, decorations);

    // Process inline tag styling
    this.processInlineTags(view, decorations, headerEndOffset);

    // Build decoration ranges
    const ranges: any[] = [];
    for (const d of decorations) {
      try {
        if (d.value.startSide !== undefined || d.value.endSide !== undefined) {
          // Line decoration
          ranges.push(Decoration.line(d.value).range(d.from));
        } else if (d.value.replace === true && d.value.widget === undefined) {
          // Replace decoration without widget: removes the range from the DOM
          // entirely so CM6 coordinate mapping matches the visible text.
          if (d.from !== d.to) {
            ranges.push(Decoration.replace({}).range(d.from, d.to));
          }
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

    // Add header tag block line decorations to hide tag lines
    if (headerEndOffset > 0) {
      const doc = view.state.doc;
      const blockLastLine = doc.lineAt(Math.max(0, Math.min(headerEndOffset - 1, doc.length))).number;
      if (shouldHideHeaderTagBlock(blockLastLine, cursorLines)) {
        for (let l = 1; l <= blockLastLine; l++) {
          const line = doc.line(l);
          ranges.push(Decoration.line({ class: 'cm-header-tag-hidden' }).range(line.from));
        }
      }
    }

    return Decoration.set(ranges, true);
  }

  private scheduleParseRefresh(view: EditorView): void {
    if (this.pendingRefresh !== null) {
      clearTimeout(this.pendingRefresh);
      this.pendingRefresh = null;
    }

    if (view.composing || view.compositionStarted) return;
    const docLength = view.state.doc.length;
    if (docLength === 0) return;

    const tree = syntaxTree(view.state);
    if (tree.length >= docLength) return;

    this.pendingRefresh = setTimeout(() => {
      this.pendingRefresh = null;
      if (this.destroyed) return;
      ensureSyntaxTree(view.state, view.state.doc.length, 200);
      view.dispatch({ effects: liveMarkdownRefresh.of(null) });
    }, 16);
  }

  private getCursorLines(view: EditorView): Set<number> {
    return getCursorLinesForReveal(view.hasFocus, view.state.selection.ranges, view.state.doc);
  }

  private isBlockElement(nodeName: string): boolean {
    return isBlockRevealSensitive(nodeName);
  }

  private isInlineElement(nodeName: string): boolean {
    return isInlineRevealSensitive(nodeName);
  }

  private isCursorInside(view: EditorView, from: number, to: number): boolean {
    return selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);
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
      this.processEmphasis(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isCode(nodeName)) {
      this.processCode(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isStrikethrough(nodeName)) {
      this.processStrikethrough(from, to, view, decorations);
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

      // Hide markdown markers (mark decoration — no widget buffers)
      decorations.push({
        from,
        to: markerEnd,
        value: { class: 'cm-md-marker-hidden' }
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
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const isStrong = nodeName === 'StrongEmphasis';
    const cssClass = isStrong ? 'cm-md-strong' : 'cm-md-emphasis';
    const markerLength = isStrong ? 2 : 1;
    const revealMarkers = shouldRevealInlineMarkers(view, from, to);

    if (text.length >= markerLength * 2) {
      if (!revealMarkers) {
        // Remove markers from the DOM via Decoration.replace so CM6's native
        // coordinate mapping matches the visible text (no hidden-char offsets).
        decorations.push({
          from,
          to: from + markerLength,
          value: { replace: true }
        });

        decorations.push({
          from: to - markerLength,
          to,
          value: { replace: true }
        });
      } else {
        // Dim the revealed markers so the emphasized text stands out.
        decorations.push({
          from,
          to: from + markerLength,
          value: { class: 'cm-md-inline-marker' }
        });
        decorations.push({
          from: to - markerLength,
          to,
          value: { class: 'cm-md-inline-marker' }
        });
      }

      // Keep emphasis styling active even when markers are revealed.
      decorations.push({
        from: revealMarkers ? from : from + markerLength,
        to: revealMarkers ? to : to - markerLength,
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
      const revealMarkers = shouldRevealInlineMarkers(view, from, to);

      if (!revealMarkers) {
        // Hide start backticks
        decorations.push({
          from,
          to: from + backticks,
          value: { class: 'cm-md-marker-hidden' }
        });

        // Hide end backticks
        decorations.push({
          from: to - backticks,
          to,
          value: { class: 'cm-md-marker-hidden' }
        });
      }

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
              value: { class: 'cm-md-marker-hidden' }
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
              value: { class: 'cm-md-marker-hidden' }
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
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const revealMarkers = shouldRevealInlineMarkers(view, from, to);

    if (!revealMarkers) {
      // Remove markers from the DOM via Decoration.replace so CM6's native
      // coordinate mapping matches the visible text (no hidden-char offsets).
      decorations.push({
        from,
        to: from + 2,
        value: { replace: true }
      });

      decorations.push({
        from: to - 2,
        to,
        value: { replace: true }
      });
    } else {
      decorations.push({
        from,
        to: from + 2,
        value: { class: 'cm-md-inline-marker' }
      });
      decorations.push({
        from: to - 2,
        to,
        value: { class: 'cm-md-inline-marker' }
      });
    }

    // Keep strikethrough styling active even when markers are revealed.
    decorations.push({
      from: revealMarkers ? from : from + 2,
      to: revealMarkers ? to : to - 2,
      value: { class: 'cm-md-strikethrough' }
    });
  }

  private processLink(
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Find the ]( boundary. Can't use a simple regex because URLs may
    // contain parentheses (e.g., Wikipedia links, Colab notebooks).
    // CM6 already parsed the correct node boundaries.
    const closeBracket = text.indexOf('](');
    if (text[0] !== '[' || closeBracket === -1) return;

    const textStart = from + 1;
    const textEnd = from + closeBracket;

    // Hide opening bracket
    decorations.push({
      from,
      to: from + 1,
      value: { class: 'cm-md-marker-hidden' }
    });

    // Hide closing bracket and URL (everything from ]( to end)
    decorations.push({
      from: textEnd,
      to,
      value: { class: 'cm-md-marker-hidden' }
    });

    // Add className to link text
    decorations.push({
      from: textStart,
      to: textEnd,
      value: { class: 'cm-md-link' }
    });
  }

  private processImage(
    from: number,
    to: number,
    text: string,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Parse ![alt](url) using indexOf, not regex, because URLs may contain parens.
    if (!text.startsWith('![')) return;
    const altEnd = text.indexOf('](');
    if (altEnd === -1) return;

    const alt = text.slice(2, altEnd);
    // URL is everything between ]( and the final )
    let url = text.slice(altEnd + 2, text.length - 1);
    // Strip optional title: url "title" → url
    const titleMatch = url.match(/\s+"[^"]*"$/);
    if (titleMatch) url = url.slice(0, -titleMatch[0].length);

    decorations.push({
      from,
      to,
      value: { widget: new ImageWidget(alt, url, to) }
    });
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
              value: { class: 'cm-md-marker-hidden' }
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

  /**
   * On cursor lines, apply only the indent padding (no marker hiding/widgets)
   * so indentation is visually consistent whether the cursor is on the line or not.
   */
  private processListItemIndentOnly(
    from: number,
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const line = doc.lineAt(from);
    const text = doc.sliceString(from, line.to);
    const realIndent = from - line.from;
    const indentLevel = Math.floor(realIndent / 2);

    // Determine marker width based on what kind of list item this is
    let markerW = BULLET_MARKER_W;
    if (text.match(/^([-*+])\s+\[([ xX])\]/)) {
      markerW = CHECKBOX_MARKER_W;
    } else if (text.match(/^\d+\.\s+\[([ xX])\]/)) {
      markerW = ORDERED_TASK_MARKER_W;
    } else if (text.match(/^\d+\.\s+/)) {
      markerW = NUMBER_MARKER_W;
    }

    // Apply same padding as the decorated version.
    // Leading whitespace stays visible (matching decorated mode where it's also visible).
    const pl = indentLevel * INDENT_STEP + markerW;
    decorations.push({
      from: line.from,
      to: line.from,
      value: { class: 'cm-md-list-line', attributes: { style: `padding-left: ${pl}px !important; text-indent: -${markerW}px;` }, startSide: 0, endSide: 0 }
    });
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

    // CM6's ListItem node `from` starts at the list marker (after indentation),
    // so `text` never has leading whitespace. Compute real indent from position.
    const realIndent = from - line.from;
    const indentLevel = Math.floor(realIndent / 2);

    // Check for unordered task first (checkbox syntax with bullet)
    const unorderedTaskMatch = text.match(/^([-*+])\s+\[([ xX])\]\s*/);
    if (unorderedTaskMatch) {
      const checked = unorderedTaskMatch[2];
      const fullMarkerLen = unorderedTaskMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide bullet and checkbox syntax
      decorations.push({
        from,
        to: contentStart,
        value: { class: 'cm-md-marker-hidden' }
      });

      // Add checkbox widget
      const checkbox = new TaskCheckboxWidget(checked === 'x' || checked === 'X');
      decorations.push({
        from,
        to: from,
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

      // Hanging indent line decoration
      const pl = indentLevel * INDENT_STEP + CHECKBOX_MARKER_W;
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: `padding-left: ${pl}px !important; text-indent: -${CHECKBOX_MARKER_W}px;` }, startSide: 0, endSide: 0 }
      });
      return;
    }

    // Check for ordered task (checkbox syntax with number)
    const orderedTaskMatch = text.match(/^(\d+)\.\s+\[([ xX])\]\s*/);
    if (orderedTaskMatch) {
      const num = parseInt(orderedTaskMatch[1]);
      const checked = orderedTaskMatch[2];
      const fullMarkerLen = orderedTaskMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide number, dot, and checkbox syntax
      decorations.push({
        from,
        to: contentStart,
        value: { class: 'cm-md-marker-hidden' }
      });

      // Add number widget
      decorations.push({
        from,
        to: from,
        value: {
          widget: new NumberWidget(num, indentLevel),
          side: -1
        }
      });

      // Add checkbox widget after number
      const checkbox = new TaskCheckboxWidget(checked === 'x' || checked === 'X');
      decorations.push({
        from,
        to: from,
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

      // Hanging indent line decoration
      const pl = indentLevel * INDENT_STEP + ORDERED_TASK_MARKER_W;
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: `padding-left: ${pl}px !important; text-indent: -${ORDERED_TASK_MARKER_W}px;` }, startSide: 0, endSide: 0 }
      });
      return;
    }

    // Regular unordered list
    const bulletMatch = text.match(/^([-*+])\s+/);
    if (bulletMatch) {
      const fullMarkerLen = bulletMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide bullet and space
      decorations.push({
        from,
        to: contentStart,
        value: { class: 'cm-md-marker-hidden' }
      });

      // Add bullet widget
      decorations.push({
        from,
        to: from,
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

      // Hanging indent line decoration
      const pl = indentLevel * INDENT_STEP + BULLET_MARKER_W;
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: `padding-left: ${pl}px !important; text-indent: -${BULLET_MARKER_W}px;` }, startSide: 0, endSide: 0 }
      });
      return;
    }

    // Ordered list
    const orderedMatch = text.match(/^(\d+)\.\s+/);
    if (orderedMatch) {
      const num = parseInt(orderedMatch[1]);
      const fullMarkerLen = orderedMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Hide number, dot and space
      decorations.push({
        from,
        to: contentStart,
        value: { class: 'cm-md-marker-hidden' }
      });

      // Add number widget
      decorations.push({
        from,
        to: from,
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

      // Hanging indent line decoration
      const pl = indentLevel * INDENT_STEP + NUMBER_MARKER_W;
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: `padding-left: ${pl}px !important; text-indent: -${NUMBER_MARKER_W}px;` }, startSide: 0, endSide: 0 }
      });
    }
  }

  private processWikilinks(
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const tree = syntaxTree(view.state);
    const regex = /\[\[([^\]\n]+)\]\]/g;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        const title = match[1];
        if (selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to)) continue;

        // Skip if inside code block or inline code
        let inCode = false;
        tree.iterate({
          from, to: from + 1,
          enter: (node) => {
            if (MarkdownParser.isCode(node.name)) inCode = true;
          }
        });
        if (inCode) continue;

        // Hide [[
        decorations.push({
          from,
          to: from + 2,
          value: { class: 'cm-md-marker-hidden' }
        });

        // Hide ]]
        decorations.push({
          from: to - 2,
          to,
          value: { class: 'cm-md-marker-hidden' }
        });

        // Style title as wikilink
        decorations.push({
          from: from + 2,
          to: to - 2,
          value: {
            class: 'cm-md-link cm-md-wikilink',
            attributes: { 'data-wikilink': title }
          }
        });
      }
    }
  }

  /**
   * Compute the header tag block end offset by scanning only the first few
   * doc lines. Cached by doc identity — CM6 Text objects are immutable,
   * so the same reference means the same content.
   */
  private getHeaderEndOffset(doc: Text): number {
    if (doc === this.cachedHeaderDoc) return this.cachedHeaderEndOffset;

    let endLineNum = 0;
    for (let i = 1; i <= doc.lines; i++) {
      if (TAG_LINE_RE.test(doc.line(i).text)) {
        endLineNum = i;
      } else {
        break;
      }
    }

    let offset = 0;
    if (endLineNum > 0) {
      offset = doc.line(endLineNum).to + 1;
      // Include trailing blank line separator if present
      if (endLineNum < doc.lines) {
        const nextLine = doc.line(endLineNum + 1);
        if (nextLine.text.trim() === '') {
          offset = nextLine.to + 1;
        }
      }
      offset = Math.min(offset, doc.length);
    }

    this.cachedHeaderDoc = doc;
    this.cachedHeaderEndOffset = offset;
    return offset;
  }

  /**
   * Iterate line-by-line for inline tags instead of materializing doc.toString().
   * Tags are line-bounded so per-line regex works correctly.
   * Header tag block offset is pre-computed and passed in.
   */
  private processInlineTags(
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>,
    headerEndOffset: number
  ): void {
    const doc = view.state.doc;
    const tree = syntaxTree(view.state);

    // Find the first line after the header tag block
    const startLineNum = headerEndOffset > 0
      ? doc.lineAt(Math.min(headerEndOffset, doc.length)).number
      : 1;

    for (let i = startLineNum; i <= doc.lines; i++) {
      const line = doc.line(i);
      // Fast-path: skip lines that can't contain a tag
      if (!line.text.includes('#')) continue;

      const regex = new RegExp(TAG_REGEX.source, TAG_REGEX.flags);
      let match;

      while ((match = regex.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + match[0].length;

        if (selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to)) continue;

        // Skip if inside code block or inline code
        let inCode = false;
        tree.iterate({
          from, to: from + 1,
          enter: (node) => {
            if (MarkdownParser.isCode(node.name)) inCode = true;
          }
        });
        if (inCode) continue;

        decorations.push({
          from,
          to,
          value: { class: 'cm-md-tag' }
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
