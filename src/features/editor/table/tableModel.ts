export type TableAlignment = 'left' | 'center' | 'right';

export interface TableCell {
  content: string;
  align: TableAlignment;
}

export interface ParsedTable {
  headers: TableCell[];
  rows: TableCell[][];
  alignments: TableAlignment[];
}

function parseCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);

  const escapedPipe = '\x00PIPE\x00';
  return trimmed
    .replace(/\\\|/g, escapedPipe)
    .split('|')
    .map((cell) => cell.replace(new RegExp(escapedPipe, 'g'), '|').trim());
}

function isAlignmentRow(line: string): boolean {
  return /^\|?[\s\-:|]+\|?$/.test(line.trim());
}

function parseAlignments(line: string): TableAlignment[] {
  return parseCells(line).map((cell) => {
    const trimmed = cell.trim();
    const hasLeft = trimmed.startsWith(':');
    const hasRight = trimmed.endsWith(':');
    if (hasLeft && hasRight) return 'center';
    if (hasRight) return 'right';
    return 'left';
  });
}

export function parseMarkdownTable(text: string): ParsedTable | null {
  const lines = text.split('\n').filter((line) => line.trim());
  if (lines.length < 2) return null;

  const headers = parseCells(lines[0]);
  if (headers.length === 0 || !isAlignmentRow(lines[1])) return null;

  const alignments = parseAlignments(lines[1]);
  while (alignments.length < headers.length) alignments.push('left');

  const headerCells = headers.map((content, index) => ({
    content,
    align: alignments[index] ?? 'left',
  }));
  const rows = lines.slice(2).map((line) => {
    const cells = parseCells(line);
    return headers.map((_, index) => ({
      content: cells[index] ?? '',
      align: alignments[index] ?? 'left',
    }));
  });

  return { headers: headerCells, rows, alignments };
}
