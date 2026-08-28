import type { EditorSnapshot } from './types';
import { SEMANTIC_ELEMENT_KIND } from './types';
import type { SemanticIntent } from './splitTortureCases';
import { semanticNodes } from './markdownStructure';

export interface IntentCheck {
  ok: boolean;
  missingStyledText: string[];
  missingVisibleText: string[];
  structureErrors: string[];
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function checkSemanticIntent(snapshot: EditorSnapshot, intent: SemanticIntent): IntentCheck {
  const elementKind = SEMANTIC_ELEMENT_KIND[intent.kind];
  const decoratedText = normalize(
    snapshot.decorations
      .filter((decoration) => decoration.kind === elementKind)
      .map((decoration) => decoration.text)
      .join(' '),
  );
  const visibleText = normalize(snapshot.visibleText);
  const parsedNodes = semanticNodes(snapshot.source, intent.kind);
  const parsedText = parsedNodes.map((node) => normalize(node.text));
  const expectedText = intent.styledText.map(normalize);
  const missingStyledText = expectedText.filter(
    (expected) => !parsedText.includes(expected) || !decoratedText.includes(expected),
  );
  const missingVisibleText = intent.visibleText.filter(
    (expected) => !visibleText.includes(normalize(expected)),
  );

  const structureErrors: string[] = [];
  const hasUnownedNode = parsedNodes.some((node) => node.paragraph < 0);
  if (hasUnownedNode) {
    structureErrors.push('a semantic node is not owned by a parsed paragraph');
  }
  if (parsedNodes.length !== expectedText.length) {
    structureErrors.push(
      `expected ${expectedText.length} semantic node(s), found ${parsedNodes.length}`,
    );
  }
  const paragraphIds = new Set(parsedNodes.map((node) => node.paragraph));
  if (
    intent.topology === 'split-paragraphs' &&
    (hasUnownedNode || paragraphIds.size !== expectedText.length)
  ) {
    structureErrors.push('semantic nodes are not split across distinct paragraphs');
  }
  if (intent.topology === 'joined-contiguous') {
    if (hasUnownedNode || paragraphIds.size !== 1) {
      structureErrors.push('semantic nodes do not share one paragraph');
    }
    const joinedText = parsedNodes.map((node) => node.text).join('');
    if (joinedText !== intent.styledText.join('')) {
      structureErrors.push('joined semantic text is not contiguous');
    }
    const first = parsedNodes[0];
    const last = parsedNodes.at(-1);
    if (first && last && snapshot.source.slice(first.from, last.to).includes('\n')) {
      structureErrors.push('joined semantic run still contains a line break');
    }
  }

  return {
    ok:
      missingStyledText.length === 0 &&
      missingVisibleText.length === 0 &&
      structureErrors.length === 0,
    missingStyledText,
    missingVisibleText,
    structureErrors,
  };
}
