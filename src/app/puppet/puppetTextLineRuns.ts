/* `doc {"line":N}` on the desktop editor: one line's pieces as the page draws them, in display
 * offsets. A stretch of text with its formats (`bold`, `italic`, `strike`, `code`, `link <url>`),
 * each object the engine draws as one unit (a list marker, a divider, a picture, a wikilink with
 * the note it opens or `broken`), and the `#tags` painted on the text. */
import type { Line } from '$features/editor/desktop/lineModel';
import { puppetPicturesOf } from './puppetPictures';

type Run = Record<string, unknown>;

const OBJECT_NODES: Record<string, string> = {
  ListMarker: 'marker',
  Divider: 'divider',
  Image: 'image',
  Wikilink: 'wikilink',
};

/** The marks a stretch from `at` (line units) is drawn with. */
function marksAt(line: Line, at: number): string[] {
  const marks: string[] = [];
  const run = line.runs.find((one) => one.start <= at && at < one.end);
  for (const format of run?.formats ?? []) marks.push(format.toLowerCase());
  const link = line.links.find((one) => one.start <= at && at < one.end);
  if (link) marks.push(`link ${link.destination}`);
  return marks;
}

function objectRun(line: Line, atom: Line['atoms'][number], element: HTMLElement): Run {
  const at = line.start + atom.start;
  const node = OBJECT_NODES[atom.kind] ?? atom.kind;
  if (atom.kind === 'Wikilink') {
    return {
      at,
      node,
      text: atom.label,
      target: atom.target,
      ...(atom.noteId ? { opens: atom.noteId } : { broken: true }),
    };
  }
  if (atom.image) {
    const picture = puppetPicturesOf(line, element).find((one) => one.at === at);
    return { at, node, source: atom.image.destination, ...(picture && { shows: picture.shows }) };
  }
  return { at, node };
}

/** Where a new piece starts on the line: a format, a link or an object begins or ends. */
function edgesOf(line: Line): number[] {
  const edges = new Set([0, line.text.length]);
  for (const piece of [...line.runs, ...line.links, ...line.atoms]) {
    edges.add(piece.start);
    edges.add(piece.end);
  }
  return [...edges].sort((a, b) => a - b);
}

export function lineRunsOf(line: Line, element: HTMLElement): Run[] {
  const runs: Run[] = [];
  const edges = edgesOf(line);
  for (let index = 0; index < edges.length - 1; index++) {
    const start = edges[index];
    const atom = line.atoms.find((one) => one.start === start);
    if (atom) {
      runs.push(objectRun(line, atom, element));
      continue;
    }
    if (line.atoms.some((one) => one.start < start && start < one.end)) continue;
    const marks = marksAt(line, start);
    runs.push({
      at: line.start + start,
      text: line.text.slice(start, edges[index + 1]),
      ...(marks.length > 0 && { marks }),
    });
  }
  return runs;
}

export function lineTagsOf(line: Line): Run[] {
  return line.tags.map((tag) => ({
    from: line.start + tag.start,
    to: line.start + tag.end,
    tag: line.text.slice(tag.start, tag.end),
  }));
}
