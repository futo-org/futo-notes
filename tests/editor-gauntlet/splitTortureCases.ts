import type { EditorIntentAction, GauntletSemanticKind, SourceSelection } from './types';

interface InlineConstruct {
  id: string;
  kind: GauntletSemanticKind;
  open: string;
  close: string;
  destination?: string;
}

export interface SemanticIntent {
  kind: GauntletSemanticKind;
  styledText: string[];
  visibleText: string[];
  topology: 'split-paragraphs' | 'joined-contiguous' | 'single-node';
}

export interface SplitTortureCase {
  id: string;
  initialSource: string;
  selection: SourceSelection;
  action: EditorIntentAction;
  intent: SemanticIntent;
}

const CONSTRUCTS: InlineConstruct[] = [
  { id: 'bold', kind: 'bold', open: '**', close: '**' },
  { id: 'italic', kind: 'italic', open: '*', close: '*' },
  { id: 'strike', kind: 'strikethrough', open: '~~', close: '~~' },
  { id: 'inline-code', kind: 'inline-code', open: '`', close: '`' },
  { id: 'double-backtick-code', kind: 'inline-code', open: '``', close: '``' },
  { id: 'wikilink', kind: 'wikilink', open: '[[', close: ']]' },
  {
    id: 'markdown-link',
    kind: 'link',
    open: '[',
    close: '](https://example.test/path)',
  },
];

function wrapped(construct: InlineConstruct, text: string): string {
  return `${construct.open}${text}${construct.close}`;
}

function intent(
  construct: InlineConstruct,
  styledText: string[],
  visibleText: string[],
  topology: SemanticIntent['topology'],
) {
  return { kind: construct.kind, styledText, visibleText, topology } satisfies SemanticIntent;
}

function enterCases(construct: InlineConstruct): SplitTortureCase[] {
  const inner = construct.id === 'double-backtick-code' ? 'alpha ` beta' : 'alpha beta';
  const source = `before ${wrapped(construct, inner)} after`;
  const contentStart = 'before '.length + construct.open.length;
  const splitOffsets = construct.id === 'double-backtick-code' ? [5, 8] : [3, 7];

  return splitOffsets.map((offset, index) => ({
    id: `${construct.id}/enter-mid-span-${index === 0 ? 'early' : 'late'}`,
    initialSource: source,
    selection: {
      anchor: contentStart + offset,
      rich: { anchor: { text: inner, offset } },
    },
    action: { type: 'enter' },
    intent: intent(
      construct,
      [inner.slice(0, offset), inner.slice(offset)].filter((piece) => piece.trim().length > 0),
      [
        'before',
        ...inner.slice(0, offset).trim().split(/\s+/),
        ...inner.slice(offset).trim().split(/\s+/),
        'after',
      ],
      'split-paragraphs',
    ),
  }));
}

function backspaceCases(construct: InlineConstruct): SplitTortureCase[] {
  return ['\n\n', '\n'].map((separator, index) => {
    const first = wrapped(construct, 'alpha');
    const second = wrapped(construct, 'beta');
    return {
      id: `${construct.id}/backspace-join-${index === 0 ? 'blocks' : 'lines'}`,
      initialSource: `${first}${separator}${second}`,
      selection: {
        anchor: first.length + separator.length,
        rich: {
          anchor: {
            text: 'beta',
            offset: 0,
            ...(construct.kind === 'wikilink' ? { atomBoundary: 'before' as const } : {}),
          },
        },
      },
      action: { type: 'backspace' },
      intent: intent(construct, ['alphabeta'], ['alphabeta'], 'joined-contiguous'),
    };
  });
}

function pasteCases(construct: InlineConstruct): SplitTortureCase[] {
  const prefix = 'before ';
  const inner = construct.id === 'double-backtick-code' ? 'alpha ` beta' : 'alpha beta';
  const suffix = ' after';
  const source = `${prefix}${wrapped(construct, inner)}${suffix}`;
  const contentStart = prefix.length + construct.open.length;
  const contentEnd = contentStart + inner.length;

  return [
    {
      id: `${construct.id}/paste-across-opening-boundary`,
      initialSource: source,
      selection: {
        anchor: prefix.length - 2,
        head: contentStart + 6,
        rich: {
          anchor: { text: prefix, offset: prefix.length - 2 },
          head: { text: inner, offset: 6 },
        },
      },
      action: { type: 'paste', text: 'GAMMA' },
      intent: intent(
        construct,
        [inner.slice(6)],
        ['befo', 'GAMMA', ...inner.slice(6).trim().split(/\s+/), 'after'],
        'single-node',
      ),
    },
    {
      id: `${construct.id}/paste-across-closing-boundary`,
      initialSource: source,
      selection: {
        anchor: contentEnd - 4,
        head: contentEnd + construct.close.length + 2,
        rich: {
          anchor: { text: inner, offset: inner.length - 4 },
          head: { text: suffix, offset: 2 },
        },
      },
      action: { type: 'paste', text: 'GAMMA' },
      intent: intent(
        construct,
        [inner.slice(0, -4)],
        ['before', ...inner.slice(0, -4).trim().split(/\s+/), 'GAMMA', 'fter'],
        'single-node',
      ),
    },
  ];
}

function markerEdgeCases(construct: InlineConstruct): SplitTortureCase[] {
  const prefix = 'before ';
  const inner = construct.id === 'double-backtick-code' ? 'alpha ` beta' : 'alpha beta';
  const source = `${prefix}${wrapped(construct, inner)} after`;
  const contentStart = prefix.length + construct.open.length;

  return [
    {
      id: `${construct.id}/type-at-opening-marker-edge`,
      initialSource: source,
      selection: {
        anchor: contentStart,
        rich: { anchor: { text: inner, offset: 0 } },
      },
      action: { type: 'insert-text', text: 'X' },
      intent: intent(
        construct,
        [`X${inner}`],
        ['before', 'Xalpha', 'beta', 'after'],
        'single-node',
      ),
    },
    {
      id: `${construct.id}/type-at-closing-marker-edge`,
      initialSource: source,
      selection: {
        anchor: contentStart + inner.length,
        rich: { anchor: { text: inner, offset: inner.length } },
      },
      action: { type: 'insert-text', text: 'X' },
      intent: intent(
        construct,
        [`${inner}X`],
        ['before', 'alpha', 'betaX', 'after'],
        'single-node',
      ),
    },
  ];
}

export const SPLIT_TORTURE_CASES: SplitTortureCase[] = CONSTRUCTS.flatMap((construct) => [
  ...enterCases(construct),
  ...backspaceCases(construct),
  ...pasteCases(construct),
  ...markerEdgeCases(construct),
]);
