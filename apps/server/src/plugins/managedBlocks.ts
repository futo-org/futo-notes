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

function isOwnedListLine(line: string): boolean {
  return /^- \[\[[^\]]+\]\](?: - .+)?$/.test(line.trim());
}

export function findHeadingSection(content: string, headingText: string): string | null {
  const trimmedHeading = headingText.trim();
  if (!trimmedHeading) return null;

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== trimmedHeading) continue;

    let cursor = index + 1;
    let sawListItem = false;
    let lastOwnedIndex = index;

    while (cursor < lines.length) {
      const trimmed = lines[cursor].trim();
      if (trimmed.length === 0) {
        if (!sawListItem) {
          cursor += 1;
          continue;
        }
        lastOwnedIndex = cursor;
        cursor += 1;
        continue;
      }
      if (!isOwnedListLine(lines[cursor])) {
        break;
      }
      sawListItem = true;
      lastOwnedIndex = cursor;
      cursor += 1;
    }

    if (!sawListItem) continue;
    while (lastOwnedIndex > index && lines[lastOwnedIndex].trim().length === 0) {
      lastOwnedIndex -= 1;
    }
    return lines.slice(index, lastOwnedIndex + 1).join('\n');
  }

  return null;
}

export function replaceHeadingSection(content: string, headingText: string, nextContent: string): string {
  const trimmedHeading = headingText.trim();
  const trimmedNext = nextContent.trim();
  if (!trimmedHeading || !trimmedNext) {
    throw new Error('Heading section content cannot be empty');
  }

  const existing = findHeadingSection(content, trimmedHeading);
  if (!existing) {
    if (content.trim().length === 0) {
      return trimmedNext;
    }
    return `${content.replace(/\n*$/, '')}\n\n${trimmedNext}`;
  }

  return content.replace(existing, trimmedNext);
}
