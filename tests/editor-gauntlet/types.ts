import type { DriverState, ElementKind } from './driver/protocol';

export type GauntletSemanticKind =
  'bold' | 'italic' | 'strikethrough' | 'inline-code' | 'wikilink' | 'link';

export interface SourceSelection {
  anchor: number;
  head?: number;
  rich?: {
    anchor: RichTextPoint;
    head?: RichTextPoint;
  };
}

export interface RichTextPoint {
  text: string;
  offset: number;
  atomBoundary?: 'before' | 'after';
}

export type EditorIntentAction =
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'insert-text'; text: string }
  | { type: 'paste'; text: string };

export interface EditorSnapshot {
  source: string;
  shellSource: string;
  savedSource: string;
  visibleText: string;
  decorations: DriverState['decorations'];
  warnings: string[];
  refused: boolean;
  mode: 'rich' | 'source' | 'exact-only' | 'unknown';
}

export interface OpenMeasurement {
  bytes: number;
  lines: number;
  synchronousMs: number;
  settledMs: number;
}

export interface KeystrokeMeasurement {
  synchronousSamplesMs: number[];
  settledToPaintSamplesMs: number[];
}

/**
 * Boundary implemented once per candidate. The four runners below this directory
 * depend only on this contract; they never reach into a candidate's editor model.
 */
export interface EditorGauntletAdapter {
  readonly name: string;
  open(source: string, caseId: string): Promise<void>;
  select(selection: SourceSelection): Promise<void>;
  perform(action: EditorIntentAction): Promise<EditorSnapshot[]>;
  save(): Promise<EditorSnapshot>;
  undo(): Promise<EditorSnapshot>;
  walkCaret(positions: number[]): Promise<void>;
  measureOpen(source: string): Promise<OpenMeasurement>;
  measureKeystrokes(count: number): Promise<KeystrokeMeasurement>;
  captureFeelState(): Promise<DriverState>;
}

export const SEMANTIC_ELEMENT_KIND: Record<GauntletSemanticKind, ElementKind> = {
  bold: 'bold-text',
  italic: 'italic-text',
  strikethrough: 'strikethrough-text',
  'inline-code': 'code-inline',
  wikilink: 'wikilink',
  link: 'link-text',
};
