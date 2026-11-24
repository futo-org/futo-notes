/* A line's `#tag`s, from the engine's projection (portable-core/tags.md): each tag's display
 * range, `#` included. A tag is plain text for the caret, the selection and typing; the page
 * only colours it (desktopTags.css), so typing in one never shifts the line. */
import type { DisplayRange } from '@futo-notes/editor/wasm-payloads';
import type { Line } from './lineModel';
import { unitsOn } from './lineLinks';

/** A tag on a line, in UTF-16 units from the line's start. */
export interface LineTag {
  start: number;
  end: number;
}

/** The class of a tag's text. */
export const TAG_CLASS = 'tag';

export const NO_TAGS: readonly LineTag[] = [];

/** The tags of `tags` (display bytes, in order, from index `first`) on `line`, whose text is
 *  `bytes` long. */
export function tagsOnLine(
  line: Line,
  bytes: number,
  tags: readonly DisplayRange[],
  first: number,
): readonly LineTag[] {
  let found: LineTag[] | null = null;
  const end = line.byteStart + bytes;
  for (let index = first; index < tags.length && tags[index].start < end; index++) {
    const range = tags[index];
    if (range.end <= line.byteStart) continue;
    const [from, to] = unitsOn(line, bytes, range.start, range.end);
    (found ??= []).push({ start: from, end: to });
  }
  return found ?? NO_TAGS;
}
