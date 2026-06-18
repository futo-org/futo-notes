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
import { scanTags } from '$lib/rules';
import { shortestUniqueSuffix, resolveWikilink, WIKILINK_RE } from './wikilinks';
import { getAllNotes } from './notes.svelte';

export const imageCacheUpdated = StateEffect.define<null>();
export const liveMarkdownRefresh = StateEffect.define<null>();

// When true, non-empty selection ranges do not reveal inline markdown
// decorators. Set during an active mouse drag so markers only reveal on
// mouseup, not incrementally as the selection grows.
let suppressSelectionReveal = false;
export function setSuppressSelectionReveal(v: boolean): void {
  suppressSelectionReveal = v;
}

export function isMarkdownSelectionRevealSuppressed(): boolean {
  return suppressSelectionReveal;
}

let frozenSelectionReveal:
  | { hasFocus: boolean; ranges: readonly SelectionRangeLike[] }
  | null = null;

export function freezeSelectionReveal(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[]
): void {
  frozenSelectionReveal = {
    hasFocus,
    ranges: ranges.map(({ from, to }) => ({ from, to }))
  };
}

export function clearSelectionRevealFreeze(): void {
  frozenSelectionReveal = null;
}

// Widget Classes
/**
 * Replaces a wikilink's title with its shortest unique path-suffix when
 * the cursor isn't inside the link. The raw on-disk text is the full
 * path; this widget keeps the displayed text short.
 *
 * The widget is only inserted when `display !== title` — otherwise the
 * existing mark decoration handles styling without an intervening DOM
 * widget (better caret behaviour and no widget-replace surprises).
 */
class WikilinkDisplayWidget extends WidgetType {
  constructor(
    private readonly display: string,
    private readonly title: string,
    private readonly broken: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = this.broken
      ? 'cm-md-link cm-md-wikilink cm-md-wikilink-broken'
      : 'cm-md-link cm-md-wikilink';
    span.setAttribute('data-wikilink', this.title);
    span.textContent = this.display;
    return span;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof WikilinkDisplayWidget &&
      other.display === this.display &&
      other.title === this.title &&
      other.broken === this.broken
    );
  }

  ignoreEvent(): boolean {
    // Allow clicks (the editor's existing wikilink click handler reads
    // `data-wikilink` from the surrounding span).
    return false;
  }
}

class ExternalLinkWidget extends WidgetType {
  // Carries an extra class string so the widget DOM picks up enclosing
  // emphasis classes (Obsidian's external-link span gets `cm-strong` /
  // `cm-em` from its parent — SF would otherwise miss bucket parity).
  constructor(private readonly extraClasses: string = '') {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = ('cm-md-external-link cm-url ' + this.extraClasses).trim();
    span.setAttribute('aria-hidden', 'true');
    return span;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ExternalLinkWidget && other.extraClasses === this.extraClasses;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

// Capitalizes / titlecases known fenced-code language slugs the way
// Obsidian's live preview labels them ("javascript" → "JavaScript",
// "python" → "Python"). Falls back to ASCII titlecase for unknown
// languages so diff coverage is still close to identical.
const CODE_LANG_LABELS: Record<string, string> = {
  javascript: 'JavaScript', typescript: 'TypeScript', tsx: 'TypeScript JSX',
  jsx: 'JavaScript JSX', python: 'Python', ruby: 'Ruby', rust: 'Rust',
  go: 'Go', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', c: 'C',
  cpp: 'C++', csharp: 'C#', html: 'HTML', css: 'CSS', json: 'JSON',
  yaml: 'YAML', xml: 'XML', sql: 'SQL', bash: 'Bash', sh: 'Bash',
  zsh: 'Zsh', shell: 'Shell', md: 'Markdown', markdown: 'Markdown',
};

function formatCodeLang(slug: string): string {
  const key = slug.toLowerCase();
  if (CODE_LANG_LABELS[key]) return CODE_LANG_LABELS[key];
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

class CodeLanguageLabelWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  toDOM(): HTMLElement {
    const div = document.createElement('div');
    div.className = 'cm-md-code-lang-label';
    div.textContent = this.label;
    return div;
  }

  eq(other: WidgetType): boolean {
    return other instanceof CodeLanguageLabelWidget && other.label === this.label;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// The total vertical footprint of a rendered HR, in px. CM6 uses a widget's
// `estimatedHeight` to size the height-map GAP for any line that is currently
// scrolled out of view; the value MUST equal what the widget actually measures
// once rendered, or CM6 corrects the gap mid-scroll and yanks scrollTop — a
// visible scroll "jump" on iOS momentum scrolling. The widget is given a
// definite height (no margins, which could collapse and make measured ≠
// estimated) so this constant is exact. See docs/learnings/hr-scroll-jank.md.
const HR_WIDGET_HEIGHT = 50;

class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('div');
    hr.className = 'cm-md-hr-widget';
    const line = document.createElement('div');
    hr.appendChild(line);
    return hr;
  }

  get estimatedHeight(): number {
    return HR_WIDGET_HEIGHT;
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
      padding-right: 4px;
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

/**
 * Set a cache entry, revoking the OUTGOING value first if it was a blob: URL
 * being replaced with a different one. blob: URLs from URL.createObjectURL leak
 * until revoked; the cache holds exactly one per filename and reuses it across
 * widget rebuilds, so we revoke only on replacement/clear — never on img load.
 * asset:// (and other non-blob) URLs pass through untouched.
 */
function setLocalImageUrl(filename: string, webUrl: string): void {
  const prev = localImageUrlCache.get(filename);
  if (prev !== undefined && prev !== webUrl && prev.startsWith('blob:')) {
    URL.revokeObjectURL(prev);
  }
  localImageUrlCache.set(filename, webUrl);
}

/** Drop all cached local-image URLs, revoking any outstanding blob: URLs. */
export function clearLocalImageUrlCache(): void {
  for (const url of localImageUrlCache.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  localImageUrlCache.clear();
}

// Max display width for images (matches CSS max-width: 100% within editor)
const MAX_IMAGE_HEIGHT = 300; // matches CSS max-height

/** Check if a src is a remote URL or data URI (not a local file reference). */
function isRemoteSrc(src: string): boolean {
  return src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:');
}

// Base URL local image filenames resolve against when the per-file cache
// misses. Set only by the native-embed host (FutoEditor.setImageBaseUrl) —
// empty on desktop, where getImageWebPath populates the cache instead.
let localImageBaseUrl = '';

/** Resolve an image src to a displayable URL. Local filenames use the cache. */
export function resolveImageSrc(src: string): string {
  if (isRemoteSrc(src)) return src;
  const cached = localImageUrlCache.get(src);
  if (cached !== undefined) return cached;
  return localImageBaseUrl ? localImageBaseUrl + encodeURIComponent(src) : '';
}

/** Register a local image filename → web URL mapping so it renders immediately. */
export function registerLocalImageUrl(filename: string, webUrl: string): void {
  setLocalImageUrl(filename, webUrl);
}

/** Register the cache-miss base URL for local images (native-embed host). */
export function setLocalImageBaseUrl(base: string): void {
  localImageBaseUrl = base;
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
          setLocalImageUrl(src, webUrl);
          // Now preload the resolved URL for dimension caching
          preloadSingleImage(webUrl);
          const v = getView?.();
          if (v) {
            v.dispatch({ effects: imageCacheUpdated.of(null) });
          }
        }).catch(() => { /* file missing — ignore */ });
      } else if (localImageUrlCache.has(src)) {
        preloadSingleImage(localImageUrlCache.get(src)!);
      } else if (localImageBaseUrl) {
        // Native embed: no getImageWebPath, resolve against the host base.
        preloadSingleImage(localImageBaseUrl + encodeURIComponent(src));
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
    // Small padding-right (not 8px — the literal space char in the doc
    // is no longer replaced; see processListItem). Together they keep
    // the visible gap close to the pre-fix value while leaving Android
    // Chrome a real text node to position its caret in.
    span.style.cssText = `padding-right: 4px; color: #666;`;
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
    // padding-right, not margin-right — see BulletWidget for rationale.
    span.style.cssText = `padding-right: 8px; color: #666; font-weight: 500;`;
    return span;
  }

  get estimatedHeight(): number {
    return 0;
  }

  eq(other: any): boolean {
    return other instanceof NumberWidget && other.num === this.num && other.indent === this.indent;
  }
}

// List indent constants (pixels)
const INDENT_STEP = 24;   // extra indent per nesting level

/**
 * Inline style for a list line. Wrapped list lines are NOT hanging-indented
 * (docs/spec/editor.md): the nesting indent rides a first-line-only positive
 * text-indent, so only the first visual line (nesting indent + marker widget
 * + text) is indented — continuation (wrapped) lines start at the left
 * margin, the same x where a wrapped plain paragraph's continuation line
 * starts. Deliberately NO padding override: a list line keeps whatever base
 * padding plain lines have (0 under the desktop .editor-container, CM6's 6px
 * default in the native embed, the cm-md-quote padding inside blockquotes),
 * so continuation alignment with plain text holds in every context by
 * construction.
 */
function listLineStyle(indentLevel: number): string {
  return `text-indent: ${indentLevel * INDENT_STEP}px;`;
}

export interface SelectionRangeLike {
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
  // ListItem deliberately excluded: clicking on a bullet should not
  // reveal the `- `/`1. ` source — Obsidian keeps the styled bullet
  // widget rendered on cursor lines too. processListItem handles the
  // cursor-on-line case directly.
  return /^(ATXHeading|FencedCode|CodeBlock|HorizontalRule)/.test(nodeName);
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
  if (frozenSelectionReveal) {
    if (!frozenSelectionReveal.hasFocus) return false;
    return selectionIntersectsRange(frozenSelectionReveal.ranges, from, to);
  }
  if (suppressSelectionReveal) return false;
  if (!hasFocus) return false;
  return selectionIntersectsRange(ranges, from, to);
}

export function selectionIntersectsRange(
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number
): boolean {
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

export function shouldRevealMarkdownSyntax(
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[],
  from: number,
  to: number
): boolean {
  return selectionTouchesRange(hasFocus, ranges, from, to);
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
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  from: number,
  to: number,
  hasFocus: boolean,
  ranges: readonly SelectionRangeLike[]
): boolean;
export function shouldSkipBlockDecorations(
  nodeName: string,
  fromOrLine: number,
  toOrCursorLines: number | Set<number>,
  hasFocus?: boolean,
  ranges?: readonly SelectionRangeLike[]
): boolean {
  if (!isBlockRevealSensitive(nodeName)) return false;

  // Backward-compatible path for older helper tests/callers that pass a line
  // number plus a cursor-line set.
  if (toOrCursorLines instanceof Set) {
    return toOrCursorLines.has(fromOrLine);
  }

  return shouldRevealMarkdownSyntax(hasFocus ?? false, ranges ?? [], fromOrLine, toOrCursorLines);
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
      // While the IME is composing, do NOT rebuild decorations: recomputing
      // mark/replace ranges over the composing text can crash the Android
      // renderer (see commit a444243). But do NOT blank the whole document
      // either — keyboards derived from AOSP LatinIME (AOSP Keyboard, FUTO
      // Keyboard) keep a composing region active during ordinary Latin typing
      // and even when the caret lands inside a word, so `Decoration.none` made
      // every decoration in the doc flash to plain text on each keystroke
      // (fine on Gboard, which composes differently). Instead keep the existing
      // decorations and just MAP them through the edit so they stay correctly
      // positioned; the full rebuild happens once composition ends.
      this.compositionSuspended = true;
      if (update.docChanged) {
        this.decorations = this.decorations.map(update.changes);
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

  // Reset per buildDecorations() pass — `tree.iterate` visits a nested
  // Blockquote node once per nest level, so naively emitting markers per
  // visit duplicates them. Track which lines have already had quote
  // decorations emitted and skip on subsequent visits.
  private quoteLinesProcessed: Set<number> = new Set();
  // Wikilink source ranges — populated up front so `processLink`/etc.
  // can suppress decorations for inner brackets like `[link](url)`
  // that fall *inside* a `[[...]]` wikilink (Obsidian folds these into
  // the wikilink title rather than re-tokenizing them).
  private wikilinkRanges: Array<{ from: number; to: number }> = [];

  private buildDecorations(view: EditorView): DecorationSet {
    if (view.composing || view.compositionStarted) {
      return Decoration.none;
    }

    const decorations: Array<{ from: number; to: number; value: any }> = [];
    const selectionRanges = view.state.selection.ranges;
    this.quoteLinesProcessed = new Set();
    this.wikilinkRanges = this.collectWikilinkRanges(view.state.doc);

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

        // Skip inline syntax nodes that fall inside a wikilink — the
        // wikilink title is treated as opaque text by Obsidian.
        if (nodeName !== 'Document' && this.isInsideWikilink(from, to)) return;

        // Skip if selection/caret reveals this block element. The shared
        // predicate handles active mouse-drag suppression and works by source
        // range intersection, so forward/backward selections behave the same.
        const blockSyntaxRevealed = this.isBlockElement(nodeName) &&
          shouldSkipBlockDecorations(nodeName, from, to, view.hasFocus, selectionRanges);

        if (blockSyntaxRevealed && !MarkdownParser.isHeading(nodeName)) {
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
        this.processElement(nodeName, from, to, view, decorations);
      }
    });

    // Process wikilinks (not part of markdown syntax tree)
    this.processWikilinks(view, decorations);

    // Process inline tag styling
    this.processInlineTags(view, decorations, headerEndOffset);

    // Match Obsidian: clip text-class marks around inner replace
    // ranges. Without this an outer emphasis (e.g., `**heading**` or
    // `*italic*` wrapping an inner `**bold**`) marks every position in
    // its range including the inner element's hidden markers, while
    // Obsidian's spans naturally split when the inner markers are
    // replaced.
    const replaceRanges: Array<{ from: number; to: number }> = [];
    for (const d of decorations) {
      if (d.value.replace === true && d.value.widget === undefined && d.from < d.to) {
        // `wrapInsideMark` flags list-marker source hides — they sit
        // inside their enclosing mark in Obsidian's DOM so don't act
        // as clip boundaries.
        if (!d.value.wrapInsideMark) replaceRanges.push({ from: d.from, to: d.to });
      } else if (d.value.widget !== undefined && d.from < d.to) {
        // Widgets that *visually replace* their source (bullet `-`,
        // ordered-list number, task checkbox, HR/image/table) sit
        // *inside* their enclosing mark span in Obsidian's DOM, so the
        // mark coverage shouldn't be clipped around them. Wikilink
        // brackets, in contrast, ARE clip boundaries — Obsidian splits
        // the surrounding span across the `[[ ]]` markers.
        const w = d.value.widget;
        // Match by constructor name rather than `instanceof` — HMR can
        // reload this module and produce two parallel class identities,
        // which breaks `instanceof` while leaving the name intact.
        const wname = w?.constructor?.name ?? '';
        const wrapInsideMark = (
          wname === 'BulletWidget' ||
          wname === 'NumberWidget' ||
          wname === 'TaskCheckboxWidget' ||
          wname === 'HorizontalRuleWidget' ||
          wname === 'ImageWidget' ||
          wname === 'CodeLanguageLabelWidget' ||
          wname === 'ExternalLinkWidget'
        );
        if (!wrapInsideMark) {
          replaceRanges.push({ from: d.from, to: d.to });
        }
      }
    }
    replaceRanges.sort((a, b) => a.from - b.from);
    const clipMark = (
      d: { from: number; to: number; value: any },
    ): Array<{ from: number; to: number; value: any }> => {
      let pieces: Array<{ from: number; to: number }> = [{ from: d.from, to: d.to }];
      for (const r of replaceRanges) {
        if (r.to <= d.from || r.from >= d.to) continue;
        const next: Array<{ from: number; to: number }> = [];
        for (const p of pieces) {
          if (r.to <= p.from || r.from >= p.to) {
            next.push(p);
            continue;
          }
          if (r.from > p.from) next.push({ from: p.from, to: r.from });
          if (r.to < p.to) next.push({ from: r.to, to: p.to });
        }
        pieces = next;
      }
      return pieces.map((p) => ({ from: p.from, to: p.to, value: d.value }));
    };

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
          // Mark decoration - skip if empty (from === to). Clip the
          // mark around any inner replace ranges so the rendered span
          // breaks at the same boundaries as Obsidian's live preview.
          // Block-level marks (quote-text, heading text, list-task) don't
          // split around inner widgets in Obsidian — only inline emphasis
          // and link text do — so target the clip narrowly.
          if (d.from !== d.to) {
            for (const piece of clipMark(d)) {
              if (piece.from < piece.to) {
                ranges.push(Decoration.mark(piece.value).range(piece.from, piece.to));
              }
            }
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
      if (!shouldRevealMarkdownSyntax(view.hasFocus, selectionRanges, 0, headerEndOffset)) {
        const blockLastLine = doc.lineAt(Math.max(0, Math.min(headerEndOffset - 1, doc.length))).number;
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

  private isBlockElement(nodeName: string): boolean {
    return isBlockRevealSensitive(nodeName);
  }

  private isInlineElement(nodeName: string): boolean {
    // Drives the early-return in buildDecorations: when the cursor is
    // inside one of these, skip decoration entirely so the source text
    // shows through. Links handle cursor reveal inside processLink
    // (mark decorations + dimmed brackets), so they do *not* belong
    // here even though `isInlineRevealSensitive(Link)` is still true
    // for other reveal-aware code paths.
    return /^(Image|Task)/.test(nodeName);
  }

  private isCursorInside(view: EditorView, from: number, to: number): boolean {
    return selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);
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
      this.processHeading(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isEmphasis(nodeName)) {
      this.processEmphasis(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isCode(nodeName)) {
      this.processCode(nodeName, from, to, text, view, decorations);
    } else if (MarkdownParser.isStrikethrough(nodeName)) {
      this.processStrikethrough(from, to, view, decorations);
    } else if (MarkdownParser.isLink(nodeName)) {
      this.processLink(from, to, text, view, decorations);
    } else if (MarkdownParser.isImage(nodeName)) {
      this.processImage(from, to, text, decorations);
    } else if (MarkdownParser.isBlockQuote(nodeName)) {
      this.processBlockQuote(from, to, view, decorations);
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
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const level = MarkdownParser.getHeadingLevel(nodeName);
    const markerMatch = text.match(/^#+/);

    if (markerMatch) {
      const markerLength = markerMatch[0].length;
      const hasSpace = text[markerLength] === ' ';
      const markerEnd = from + markerLength + (hasSpace ? 1 : 0);
      const revealMarkers = shouldRevealMarkdownSyntax(view.hasFocus, view.state.selection.ranges, from, to);

      if (!revealMarkers) {
        decorations.push({
          from,
          to: markerEnd,
          value: { replace: true }
        });
      } else {
        decorations.push({
          from,
          to: markerEnd,
          value: { class: `cm-md-inline-marker cm-md-h${level}-marker` }
        });
        // Match Obsidian: revealed `#` markers also carry the heading
        // text class so the styling continues across them (Obsidian's
        // `cm-header-N` lives on the same span as `cm-formatting-header`).
        decorations.push({
          from,
          to: markerEnd,
          value: { class: `cm-md-h${level}` }
        });
      }

      // Keep heading styling active even when the marker is revealed.
      decorations.push({
        from: markerEnd,
        to: to,
        value: {
          class: `cm-md-h${level}`,
          attributes: { 'data-heading-level': level.toString() }
        }
      });

      // Line-level decoration so the WHOLE line (not just the inner
      // text) gets the heading font-size and line-height. Without it
      // the line stays at body line-height and the heading text just
      // overflows or shrinks visually. Mirrors Obsidian's
      // `HyperMD-header-N` line class.
      const doc = view.state.doc;
      const line = doc.lineAt(from);
      decorations.push({
        from: line.from,
        to: line.from,
        value: {
          class: `cm-md-h${level}-line`,
          startSide: 0,
          endSide: 0,
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
        const markerClass = isStrong
          ? 'cm-md-inline-marker cm-md-strong-marker'
          : 'cm-md-inline-marker cm-md-emphasis-marker';
        decorations.push({
          from,
          to: from + markerLength,
          value: { class: markerClass }
        });
        decorations.push({
          from: to - markerLength,
          to,
          value: { class: markerClass }
        });
        // Match Obsidian: when revealed, the marker spans also carry
        // the emphasis text class so the styling continues visually
        // across the markers (Obsidian's `cm-em` / `cm-strong` lives
        // on the same DOM span as `cm-formatting-em`).
        decorations.push({
          from,
          to: from + markerLength,
          value: { class: cssClass }
        });
        decorations.push({
          from: to - markerLength,
          to,
          value: { class: cssClass }
        });
      }

      // Emphasis styling spans only the inner text — never the markers
      // — so the diff against Obsidian (which decorates inner-only)
      // lines up. The marker decorations above carry the marker classes
      // and provide the dimming/CSS hooks for the markers themselves.
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
      const revealMarkers = shouldRevealInlineMarkers(view, from, to);

      if (!revealMarkers) {
        decorations.push({
          from,
          to: from + backticks,
          value: { replace: true }
        });

        decorations.push({
          from: to - backticks,
          to,
          value: { replace: true }
        });
      } else {
        decorations.push({
          from,
          to: from + backticks,
          value: { class: 'cm-md-inline-marker cm-md-code-marker' }
        });
        decorations.push({
          from: to - backticks,
          to,
          value: { class: 'cm-md-inline-marker cm-md-code-marker' }
        });
      }

      decorations.push({
        from: from + backticks,
        to: to - backticks,
        value: { class: 'cm-md-code' }
      });
    } else {
      // FencedCode or CodeBlock — every line in the block gets the styled
      // container; fence chars are only hidden when the caret is outside.
      const doc = view.state.doc;
      const startLine = doc.lineAt(from);
      const endLine = doc.lineAt(to);
      const hasClosingFence = endLine.number !== startLine.number && /^\s*(`{3,}|~{3,})\s*$/.test(endLine.text);
      const contentStartLine = nodeName === 'FencedCode' ? startLine.number + 1 : startLine.number;
      const contentEndLine = nodeName === 'FencedCode' && hasClosingFence ? endLine.number - 1 : endLine.number;
      const contentLineCount = Math.max(0, contentEndLine - contentStartLine + 1);
      const cursorInBlock = selectionTouchesRange(
        view.hasFocus,
        view.state.selection.ranges,
        from,
        to
      );

      for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
        const line = doc.line(lineNum);
        const openingMatch = lineNum === startLine.number && line.text.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/);
        const isOpening = !!openingMatch;
        const isClosing = lineNum === endLine.number && hasClosingFence;

        if ((isOpening || isClosing) && !cursorInBlock && line.from < line.to) {
          // Match Obsidian: when the opening fence carries a language
          // tag, render it as a label widget at the top of the block;
          // otherwise just hide the fence line.
          if (isOpening && openingMatch && openingMatch[2]) {
            decorations.push({
              from: line.from,
              to: line.to,
              value: { widget: new CodeLanguageLabelWidget(formatCodeLang(openingMatch[2])) }
            });
          } else {
            decorations.push({
              from: line.from,
              to: line.to,
              value: { replace: true }
            });
          }
        }

        let posClass = 'cm-md-code-block';
        if ((isOpening || isClosing) && !cursorInBlock) {
          posClass += ' cm-md-code-block-fence';
          if (isOpening) posClass += ' cm-md-code-block-opening-fence';
          if (isClosing) posClass += ' cm-md-code-block-closing-fence';
        } else if (contentLineCount <= 1) {
          posClass += ' cm-md-code-block-single';
        } else if (lineNum === contentStartLine) {
          posClass += ' cm-md-code-block-first';
        } else if (lineNum === contentEndLine) {
          posClass += ' cm-md-code-block-last';
        } else {
          posClass += ' cm-md-code-block-middle';
        }

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
        value: { class: 'cm-md-inline-marker cm-md-strikethrough-marker' }
      });
      decorations.push({
        from: to - 2,
        to,
        value: { class: 'cm-md-inline-marker cm-md-strikethrough-marker' }
      });
      // Match Obsidian: revealed `~~` markers also carry the
      // strikethrough text class so the styling spans them.
      decorations.push({
        from,
        to: from + 2,
        value: { class: 'cm-md-strikethrough' }
      });
      decorations.push({
        from: to - 2,
        to,
        value: { class: 'cm-md-strikethrough' }
      });
    }

    // Strikethrough decoration covers only the inner text (matches
    // Obsidian's range; markers carry their own decoration above).
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
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    // Find the ]( boundary. Can't use a simple regex because URLs may
    // contain parentheses (e.g., Wikipedia links, Colab notebooks).
    // CM6 already parsed the correct node boundaries.
    const closeBracket = text.indexOf('](');
    if (text[0] !== '[' || closeBracket === -1) return;

    const textStart = from + 1;
    const textEnd = from + closeBracket;
    const urlStart = textEnd + 2; // after ](
    const urlEnd = to - 1;        // before )
    const reveal = shouldRevealInlineMarkers(view, from, to);

    if (!reveal) {
      // Default: hide the brackets and URL — show only the link text.
      decorations.push({
        from,
        to: from + 1,
        value: { replace: true }
      });
      decorations.push({
        from: textEnd,
        to,
        value: { replace: true }
      });
      decorations.push({
        from: textStart,
        to: textEnd,
        value: { class: 'cm-md-link' }
      });
    } else {
      // Cursor on the link → keep the source visible but style it like
      // Obsidian's live preview: dim brackets/URL, color the text and URL.
      // The `[` and `]` brackets carry both the marker class and the
      // link-text class (Obsidian's `cm-formatting-link cm-link` pair),
      // and the URL parens carry the link-url class (Obsidian's
      // `cm-formatting-link-string cm-url` pair).
      decorations.push({
        from,
        to: from + 1,
        value: { class: 'cm-md-inline-marker cm-md-link-marker cm-md-link' }
      });
      decorations.push({
        from: textStart,
        to: textEnd,
        value: { class: 'cm-md-link' }
      });
      decorations.push({
        from: textEnd,
        to: textEnd + 1,
        value: { class: 'cm-md-inline-marker cm-md-link-marker cm-md-link' }
      });
      decorations.push({
        from: textEnd + 1,
        to: urlStart,
        value: { class: 'cm-md-link-url' }
      });
      if (urlStart < urlEnd) {
        decorations.push({
          from: urlStart,
          to: urlEnd,
          value: { class: 'cm-md-link-url' }
        });
      }
      decorations.push({
        from: urlEnd,
        to,
        value: { class: 'cm-md-link-url' }
      });
    }

    // Match Obsidian: append a zero-width external-link affordance at
    // the end of every external link, regardless of cursor reveal. The
    // diff buckets it as `link-url` so it lines up with Obsidian's
    // formatting-link-string widget.
    const url = view.state.doc.sliceString(urlStart, urlEnd);
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      // Walk the syntax tree at the widget point to find any
      // surrounding StrongEmphasis / Emphasis / Strikethrough wrappers
      // and copy their class onto the widget DOM. Obsidian's
      // external-link span inherits these classes via its parent span,
      // so SF widgets need the same to stay in the same diff buckets.
      const enclosingClasses: string[] = [];
      const tree = syntaxTree(view.state);
      const cursor = tree.cursorAt(to);
      do {
        if (cursor.name === 'StrongEmphasis' && cursor.from < to && cursor.to > to) enclosingClasses.push('cm-md-strong');
        else if (cursor.name === 'Emphasis' && cursor.from < to && cursor.to > to) enclosingClasses.push('cm-md-emphasis');
        else if (cursor.name === 'Strikethrough' && cursor.from < to && cursor.to > to) enclosingClasses.push('cm-md-strikethrough');
      } while (cursor.parent());

      decorations.push({
        from: to,
        to: to,
        value: {
          widget: new ExternalLinkWidget(enclosingClasses.join(' ')),
          side: 1,
        }
      });
    }
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
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    const selectionRanges = view.state.selection.ranges;

    // Collect all quote lines for position-aware styling
    const quoteLines: { lineNum: number; nestLevel: number }[] = [];

    for (let i = startLine; i <= endLine; i++) {
      // Skip lines we've already decorated (a nested Blockquote node visits
      // the same line as its outer parent).
      if (this.quoteLinesProcessed.has(i)) continue;
      const line = doc.line(i);
      const lineText = line.text;

      // Walk the marker run, emitting one segment per nesting level.
      // Each segment covers the `>` AND the optional trailing space —
      // earlier versions matched Obsidian's tree by leaving the bare
      // `>` undecorated at level 2+, but SF hides marker segments via
      // `cm-md-quote-marker-hidden` (color: transparent; font-size: 0)
      // and an undecorated `>` leaked through visibly on nested lines.
      // Obsidian renders `>` as visible source (just colored), so the
      // tree-shape parity didn't matter to them.
      const segments: { from: number; to: number; level: number }[] = [];
      let nestLevel = 0;
      let pos = 0;
      while (pos < lineText.length && lineText[pos] === '>') {
        nestLevel++;
        const start = pos;
        pos++;
        if (lineText[pos] === ' ') pos++;
        segments.push({ from: line.from + start, to: line.from + pos, level: nestLevel });
      }

      if (nestLevel > 0) {
        const revealMarker = shouldRevealMarkdownSyntax(view.hasFocus, selectionRanges, line.from, line.to);
        for (const seg of segments) {
          if (seg.from === seg.to) continue;
          decorations.push({
            from: seg.from,
            to: seg.to,
            value: { class: revealMarker ? `cm-md-quote-marker cm-md-quote-marker-${seg.level}` : `cm-md-quote-marker-hidden cm-md-quote-marker-${seg.level}` }
          });
        }
        // Match Obsidian: emit a mark decoration over the quote text body
        // so the factory diff and downstream styling can find the body.
        if (line.from + pos < line.to) {
          decorations.push({
            from: line.from + pos,
            to: line.to,
            value: { class: `cm-md-quote-text cm-md-quote-text-${nestLevel}` }
          });
        }

        quoteLines.push({ lineNum: i, nestLevel });
        this.quoteLinesProcessed.add(i);
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
   * On cursor lines, apply only the first-line indent (no marker hiding/widgets)
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

    // Determine the marker's source length so it can carry the list-marker
    // class below, matching what kind of list item this is.
    let markerSourceLen = 0;
    const taskMatch = text.match(/^([-*+])\s+\[([ xX])\]\s*/);
    const orderedTaskMatch = text.match(/^(\d+)\.\s+\[([ xX])\]\s*/);
    const orderedMatch = text.match(/^(\d+)\.\s+/);
    const bulletMatch = text.match(/^([-*+])\s+/);
    if (taskMatch) {
      markerSourceLen = taskMatch[0].length;
    } else if (orderedTaskMatch) {
      markerSourceLen = orderedTaskMatch[0].length;
    } else if (orderedMatch) {
      markerSourceLen = orderedMatch[0].length;
    } else if (bulletMatch) {
      markerSourceLen = bulletMatch[0].length;
    }

    // Apply the same first-line indent as the decorated version.
    // Leading whitespace stays visible (matching decorated mode where it's also visible).
    decorations.push({
      from: line.from,
      to: line.from,
      value: { class: 'cm-md-list-line', attributes: { style: listLineStyle(indentLevel) }, startSide: 0, endSide: 0 }
    });

    // Match Obsidian: even when the cursor reveals a list line, the
    // bullet/number range still carries the list-marker class so the
    // diff and CSS hooks line up with Obsidian's `cm-formatting-list`.
    if (markerSourceLen > 0) {
      decorations.push({
        from,
        to: from + markerSourceLen,
        value: { class: 'cm-md-bullet cm-md-list-marker' }
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

      // Hide bullet and checkbox syntax. `wrapInsideMark` flags this
      // replace as a list-marker hide so the clip-mark pass doesn't
      // split surrounding mark spans (e.g. the enclosing blockquote
      // text class) around it — Obsidian's DOM nests the bullet
      // inside the quote span.
      decorations.push({
        from,
        to: contentStart,
        value: { replace: true, wrapInsideMark: true }
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

      // First-line-only indent — no hanging indent (see listLineStyle)
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: listLineStyle(indentLevel) }, startSide: 0, endSide: 0 }
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

      // Hide number, dot, and checkbox syntax — see wrapInsideMark
      // note above; the same nesting logic applies here.
      decorations.push({
        from,
        to: contentStart,
        value: { replace: true, wrapInsideMark: true }
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

      // First-line-only indent — no hanging indent (see listLineStyle)
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: listLineStyle(indentLevel) }, startSide: 0, endSide: 0 }
      });
      return;
    }

    // Regular unordered list
    const bulletMatch = text.match(/^([-*+])\s+/);
    if (bulletMatch) {
      const fullMarkerLen = bulletMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Replace ONLY the marker character with the bullet widget; leave
      // the trailing whitespace in the document. Without that real text
      // node, Android Chrome can't position its DOM selection between
      // the widget and the bullet text — the caret anchors at the line's
      // left edge regardless of CM6's actual selection state. (See
      // bug-f80730c4 from 2026-05-01.)
      decorations.push({
        from,
        to: from + 1,
        value: {
          widget: new BulletWidget(indentLevel),
          // Decoration.replace + widget is a point widget; no `side`
          // override — CM6 places it where the replaced range was.
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

      // First-line-only indent — no hanging indent (see listLineStyle)
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: listLineStyle(indentLevel) }, startSide: 0, endSide: 0 }
      });
      return;
    }

    // Ordered list
    const orderedMatch = text.match(/^(\d+)\.\s+/);
    if (orderedMatch) {
      const num = parseInt(orderedMatch[1]);
      const fullMarkerLen = orderedMatch[0].length;
      const contentStart = from + fullMarkerLen;

      // Replace `N. ` source text with the number widget in a single
      // decoration so its DOM element maps to from..contentStart.
      decorations.push({
        from,
        to: contentStart,
        value: { widget: new NumberWidget(num, indentLevel) }
      });

      // Add className to content
      if (contentStart < lineEnd) {
        decorations.push({
          from: contentStart,
          to: lineEnd,
          value: { class: 'cm-md-ol-item' }
        });
      }

      // First-line-only indent — no hanging indent (see listLineStyle)
      decorations.push({
        from: line.from,
        to: line.from,
        value: { class: 'cm-md-list-line', attributes: { style: listLineStyle(indentLevel) }, startSide: 0, endSide: 0 }
      });
    }
  }

  // Pre-pass that collects the source ranges of every `[[...]]`
  // wikilink in the doc. Populated at the top of `buildDecorations`
  // so other process* methods can skip inner Link/Code/Emphasis nodes
  // that fall inside a wikilink — Obsidian folds those into the
  // wikilink title and doesn't re-decorate them.
  private collectWikilinkRanges(doc: Text): Array<{ from: number; to: number }> {
    const ranges: Array<{ from: number; to: number }> = [];
    const regex = new RegExp(WIKILINK_RE.source, 'g');
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(line.text)) !== null) {
        ranges.push({ from: line.from + m.index, to: line.from + m.index + m[0].length });
      }
    }
    return ranges;
  }

  private isInsideWikilink(from: number, to: number): boolean {
    for (const r of this.wikilinkRanges) {
      if (r.from <= from && to <= r.to) return true;
    }
    return false;
  }

  private processWikilinks(
    view: EditorView,
    decorations: Array<{ from: number; to: number; value: any }>
  ): void {
    const doc = view.state.doc;
    const tree = syntaxTree(view.state);
    // Match `[[...]]` where the inner can contain anything except a
    // newline or a closing `]]`. Permissive on purpose — mirrors
    // Obsidian's parse, which folds `[link](url)` and other bracket
    // syntax into the wikilink title rather than re-tokenizing.
    const regex = new RegExp(WIKILINK_RE.source, 'g');

    // Build the resolution context once per pass: the set of all
    // current note IDs. Used both for shortest-unique-suffix display
    // and to flag broken links via a CSS class.
    const allNoteIds = getAllNotes().map((n) => n.id);

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        const title = match[1];
        const reveal = selectionTouchesRange(view.hasFocus, view.state.selection.ranges, from, to);

        // Skip if inside code block or inline code
        let inCode = false;
        tree.iterate({
          from, to: from + 1,
          enter: (node) => {
            if (MarkdownParser.isCode(node.name)) inCode = true;
          }
        });
        if (inCode) continue;

        // Resolve the wikilink to a note ID so we can:
        //   1. compute the shortest unique suffix to display, and
        //   2. flag broken links visually.
        const resolvedId = resolveWikilink(title, allNoteIds);
        const displayText =
          resolvedId !== null
            ? shortestUniqueSuffix(resolvedId, allNoteIds)
            : title;
        const isBroken = resolvedId === null;

        if (!reveal) {
          // Hide the brackets when the cursor is elsewhere.
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

          // If the on-disk text differs from the displayed shortest-
          // unique-suffix, replace the title with a widget showing the
          // suffix. When the cursor enters the link (reveal=true), the
          // raw text is shown instead so editing stays predictable.
          if (displayText !== title) {
            decorations.push({
              from: from + 2,
              to: to - 2,
              value: {
                widget: new WikilinkDisplayWidget(displayText, title, isBroken),
              },
            });
            continue;
          }
        }

        // Style title as wikilink — kept on the inner text in both
        // modes so Obsidian's `cm-hmd-internal-link` and SF stay in
        // the same diff bucket.
        const wikilinkClass = isBroken
          ? 'cm-md-link cm-md-wikilink cm-md-wikilink-broken'
          : 'cm-md-link cm-md-wikilink';
        decorations.push({
          from: from + 2,
          to: to - 2,
          value: {
            class: wikilinkClass,
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
    _headerEndOffset: number
  ): void {
    const doc = view.state.doc;
    const tree = syntaxTree(view.state);

    // Tag-style decorations are emitted across the whole document,
    // including the header tag block. The header block has its own
    // line decoration to hide it visually; tag mark decorations don't
    // affect display, so it's safe to overlap them.
    const startLineNum = 1;

    for (let i = startLineNum; i <= doc.lines; i++) {
      const line = doc.line(i);
      // Fast-path: skip lines that can't contain a tag
      if (!line.text.includes('#')) continue;

      // Linear scan (not the backtracking TAG_REGEX) — runs per-keystroke over
      // each line, so it must not be able to ReDoS. `m.end - m.start` == the
      // old `match[0].length` (`#` + name; the look-around is zero-width).
      for (const m of scanTags(line.text)) {
        const from = line.from + m.start;
        const to = line.from + m.end;

        // Tags stay styled regardless of cursor position — no "reveal"
        // mode like wikilinks/emphasis, since the source text is the
        // rendered text. Matches Obsidian's behavior in live preview.

        // Skip if inside code block or inline code
        let inCode = false;
        tree.iterate({
          from, to: from + 1,
          enter: (node) => {
            if (MarkdownParser.isCode(node.name)) inCode = true;
          }
        });
        if (inCode) continue;

        // Match Obsidian's structure: split into marker (#) + text (rest).
        // Obsidian emits two separate decorations; we mirror so the
        // factory diff lines up. Both classes route to `tag` via classToKind.
        decorations.push({
          from,
          to: from + 1,
          value: { class: 'cm-md-tag cm-md-tag-marker' }
        });
        if (to > from + 1) {
          decorations.push({
            from: from + 1,
            to,
            value: { class: 'cm-md-tag cm-md-tag-text' }
          });
        }
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
