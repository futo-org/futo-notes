export type ListMarkerKind = 'unordered' | 'ordered';

export interface ListDetectionCounts {
  regularItems: number;
  otherNonBlankLines: number;
}

export interface ListBlockStyle {
  kind: ListMarkerKind;
  indent: string;
  bullet?: '-' | '*' | '+';
  nextNumber?: number;
}

export interface FirstListBlock extends ListBlockStyle {
  startLine: number;
  endLine: number;
}

interface ParsedListLine {
  kind: ListMarkerKind;
  indent: string;
  bullet?: '-' | '*' | '+';
  number?: number;
}

const UNORDERED_TASK_RE = /^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/;
const ORDERED_TASK_RE = /^(\s*)(\d+)\.\s+\[([ xX])\]\s*(.*)$/;
const UNORDERED_RE = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED_RE = /^(\s*)(\d+)\.\s+(.*)$/;

function parseRegularListLine(line: string): ParsedListLine | null {
  if (UNORDERED_TASK_RE.test(line) || ORDERED_TASK_RE.test(line)) {
    return null;
  }

  const unordered = line.match(UNORDERED_RE);
  if (unordered) {
    return {
      kind: 'unordered',
      indent: unordered[1],
      bullet: unordered[2] as '-' | '*' | '+',
    };
  }

  const ordered = line.match(ORDERED_RE);
  if (ordered) {
    return {
      kind: 'ordered',
      indent: ordered[1],
      number: Number.parseInt(ordered[2], 10),
    };
  }

  return null;
}

function hasBlankContent(line: string): boolean {
  return line.trim().length === 0;
}

export function countRegularListLines(content: string): ListDetectionCounts {
  let regularItems = 0;
  let otherNonBlankLines = 0;

  for (const line of content.split('\n')) {
    if (hasBlankContent(line)) continue;
    if (parseRegularListLine(line)) {
      regularItems += 1;
      continue;
    }
    otherNonBlankLines += 1;
  }

  return { regularItems, otherNonBlankLines };
}

export function qualifiesAsListNote(content: string): boolean {
  const counts = countRegularListLines(content);
  return counts.regularItems >= 3 && counts.regularItems > counts.otherNonBlankLines;
}

export function findFirstRegularListBlock(content: string): FirstListBlock | null {
  const lines = content.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const first = parseRegularListLine(lines[index]);
    if (!first) {
      continue;
    }

    let endLine = index;
    let lastTopLevelNumber = first.kind === 'ordered' ? first.number ?? 1 : undefined;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = parseRegularListLine(lines[cursor]);
      if (!next) break;
      endLine = cursor;
      if (first.kind === 'ordered' && next.kind === 'ordered' && next.indent === first.indent && typeof next.number === 'number') {
        lastTopLevelNumber = next.number;
      }
    }

    return {
      kind: first.kind,
      indent: first.indent,
      bullet: first.bullet,
      nextNumber: first.kind === 'ordered' ? (lastTopLevelNumber ?? 0) + 1 : undefined,
      startLine: index,
      endLine,
    };
  }

  return null;
}

export function buildInsertedListText(
  sourceContent: string,
  style: ListBlockStyle,
): string {
  const lines = sourceContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return '';
  }

  const parentMarker = style.kind === 'unordered'
    ? style.bullet ?? '-'
    : `${style.nextNumber ?? 1}.`;
  const childIndent = `${style.indent}  `;

  const inserted = [`${style.indent}${parentMarker} ${lines[0]}`];
  for (let index = 1; index < lines.length; index += 1) {
    const childMarker = style.kind === 'unordered'
      ? style.bullet ?? '-'
      : `${index}.`;
    inserted.push(`${childIndent}${childMarker} ${lines[index]}`);
  }

  return inserted.join('\n');
}

export function appendToFirstRegularListBlock(
  content: string,
  insertedListText: string,
  opts?: { allowCreateBlock?: boolean },
): string {
  const block = findFirstRegularListBlock(content);
  if (!block) {
    if (!opts?.allowCreateBlock) {
      throw new Error('Destination note no longer contains a regular list block');
    }
    if (content.trim().length === 0) {
      return insertedListText;
    }
    return content.endsWith('\n')
      ? `${content}${insertedListText}`
      : `${content}\n${insertedListText}`;
  }

  const lines = content.split('\n');
  lines.splice(block.endLine + 1, 0, insertedListText);
  return lines.join('\n');
}
