// The contract both editors implement so the judge can compare them.
// FUTO Notes attaches an instance to window.__driver in dev builds.
// Obsidian exposes the same shape over an HTTP endpoint via a plugin.
//
// Two design constraints:
//   1. State must be extractable from the live DOM, because both editors
//      apply decorations through plugins we don't control end-to-end.
//   2. Semantic kinds (bold-marker, heading-text-2, etc.) are derived
//      from raw classes at capture time. Both editors use
//      @codemirror/lang-markdown, so the class sets overlap enough to
//      map. Class-to-kind mapping lives in semanticKind.ts.

export interface Position {
  line: number;
  ch: number;
  pos: number; // absolute offset in doc, useful when line/ch is ambiguous
}

export interface Selection {
  head: Position;
  anchor: Position;
}

export type ElementKind =
  // Inline emphasis
  | 'bold-text'
  | 'bold-marker'
  | 'italic-text'
  | 'italic-marker'
  | 'strikethrough-text'
  | 'strikethrough-marker'
  // Headings (level 1..6)
  | 'heading-text-1'
  | 'heading-text-2'
  | 'heading-text-3'
  | 'heading-text-4'
  | 'heading-text-5'
  | 'heading-text-6'
  | 'heading-marker'
  // Code
  | 'code-inline'
  | 'code-block'
  | 'code-fence-marker'
  | 'code-lang'
  // Links
  | 'link-text'
  | 'link-url'
  | 'link-marker'
  | 'autolink'
  // Lists
  | 'list-marker'
  | 'list-task-checkbox'
  | 'list-task-text'
  // Blockquotes
  | 'quote-marker'
  | 'quote-text'
  // Block-level widgets
  | 'hr-widget'
  | 'image-widget'
  | 'table-widget'
  // FUTO Notes / Obsidian extras
  | 'wikilink'
  | 'tag'
  // Fallback
  | 'unknown';

export interface DecoratedRange {
  from: Position;
  to: Position;
  kind: ElementKind;
  // Whether the range is replaced by a widget or hidden entirely
  // (Decoration.replace) vs just decorated with classes (Decoration.mark).
  replaced: boolean;
  // Raw classes from the DOM, kept for debugging.
  classes: string[];
  // Text content of the range (post-replacement = the widget text or empty).
  text: string;
}

export interface DriverState {
  doc: string;
  cursor: Position;
  selection: Selection;
  decorations: DecoratedRange[];
  // innerText of .cm-content with the current cursor, after any
  // live-preview hide/reveal rules have run.
  visibleText: string;
}

export type DriverEvent =
  | { type: 'place_cursor'; line: number; ch: number }
  | { type: 'set_doc'; markdown: string }
  | {
      type: 'key';
      key:
        | 'ArrowUp'
        | 'ArrowDown'
        | 'ArrowLeft'
        | 'ArrowRight'
        | 'Home'
        | 'End'
        | 'Enter'
        | 'Backspace'
        | 'Delete'
        | 'Escape';
    }
  | { type: 'type'; text: string }
  | { type: 'blur' }
  | { type: 'focus' };

// What both editors implement.
export interface Driver {
  setDoc(markdown: string): Promise<void>;
  dispatch(events: DriverEvent[]): Promise<void>;
  state(): Promise<DriverState>;
  // Implementation hint for the judge: which editor is this?
  identify(): Promise<{ name: 'futo-notes' | 'obsidian'; version: string }>;
}
