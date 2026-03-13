export function blockMarkers(blockId: string): { start: string; end: string } {
  return {
    start: `<!-- stonefruit:${blockId}:start -->`,
    end: `<!-- stonefruit:${blockId}:end -->`,
  };
}

export function renderManagedBlock(blockId: string, content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('Managed block content cannot be empty');
  }

  const { start, end } = blockMarkers(blockId);
  return `${start}\n${trimmed}\n${end}`;
}

export function replaceManagedBlock(content: string, blockId: string, nextContent: string): string {
  const nextBlock = renderManagedBlock(blockId, nextContent);
  const { start, end } = blockMarkers(blockId);
  const startIndex = content.indexOf(start);

  if (startIndex >= 0) {
    const endIndex = content.indexOf(end, startIndex + start.length);
    const suffixStart = endIndex >= 0 ? endIndex + end.length : content.length;
    return `${content.slice(0, startIndex)}${nextBlock}${content.slice(suffixStart)}`;
  }

  if (content.trim().length === 0) {
    return nextBlock;
  }

  return `${content.replace(/\n*$/, '')}\n\n${nextBlock}`;
}

export function findManagedBlock(content: string, blockId: string): string | null {
  const { start, end } = blockMarkers(blockId);
  const startIndex = content.indexOf(start);
  if (startIndex < 0) return null;

  const endIndex = content.indexOf(end, startIndex + start.length);
  const suffixStart = endIndex >= 0 ? endIndex + end.length : content.length;
  return content.slice(startIndex, suffixStart);
}
