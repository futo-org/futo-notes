// Corpus descriptors, not editing rules. Lezer CommonMark + GFM excludes code
// fences from prose/lists and recognizes multiline/nested structures. Each note
// has equal weight; feature percentiles condition on notes containing it.
import { Buffer } from 'node:buffer';
import { parser, GFM } from '@lezer/markdown';
const markdown = parser.configure(GFM);
export const metrics = ['noteBytes', 'paragraphChars', 'listItems', 'tableCells'];
export const quantiles = [50, 95, 99, 100];
export function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil((sorted.length * q) / 100) - 1)];
}
function descendants(node, name) {
  const out = [];
  function walk(n) {
    if (n.name === name) out.push(n);
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  }
  walk(node);
  return out;
}
// Choose the end of literal prose, avoiding link destinations/format markers.
function literalEnds(node, body) {
  const out = [];
  if (/^(Code|InlineCode|Link|Image|Autolink|HTML|.*Mark|.*Delimiter|URL)/.test(node.name))
    return out;
  let at = node.from;
  const gap = (end) => {
    const text = body.slice(at, end);
    const match = text.match(/[\p{L}\p{N}][^\p{L}\p{N}]*$/u);
    if (match) out.push(at + match.index + [...match[0]][0].length);
  };
  for (let c = node.firstChild; c; c = c.nextSibling) {
    gap(c.from);
    out.push(...literalEnds(c, body));
    at = c.to;
  }
  gap(node.to);
  return out;
}
export function describe(note) {
  const body = note.body;
  const tree = markdown.parse(body);
  const paragraphs = [],
    lists = [],
    tables = [];
  function walk(node, listDepth = 0) {
    const isList = node.name === 'BulletList' || node.name === 'OrderedList';
    if (isList && listDepth === 0) {
      const items = descendants(node, 'ListItem');
      const ends = items.flatMap((item) => {
        const p = item.getChild('Paragraph');
        return p ? literalEnds(p, body).slice(-1) : [];
      });
      let depth = 0;
      function nesting(n, d) {
        if (n.name === 'BulletList' || n.name === 'OrderedList') d++;
        depth = Math.max(depth, d);
        for (let c = n.firstChild; c; c = c.nextSibling) nesting(c, d);
      }
      nesting(node, 0);
      lists.push({
        value: items.length,
        from: node.from,
        to: node.to,
        ends,
        depth,
        tasks: descendants(node, 'Task').length,
      });
    }
    if (node.name === 'Paragraph' && listDepth === 0)
      paragraphs.push({
        value: node.to - node.from,
        from: node.from,
        to: node.to,
        ends: literalEnds(node, body),
      });
    if (node.name === 'Table') {
      const cells = descendants(node, 'TableCell');
      const separator = node.getChild('TableDelimiter');
      const columns = separator
        ? body
            .slice(separator.from, separator.to)
            .split('|')
            .filter((s) => s.trim()).length
        : 0;
      const rows = descendants(node, 'TableRow').length + 1;
      tables.push({
        value: rows * columns,
        from: node.from,
        to: node.to,
        rows,
        columns,
        ends: cells.flatMap((cell) => literalEnds(cell, body).slice(-1)),
      });
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c, listDepth + Number(isList));
  }
  walk(tree.topNode);
  const max = (xs) => xs.sort((a, b) => b.value - a.value || a.from - b.from)[0] ?? null;
  const para = max(paragraphs),
    list = max(lists),
    table = max(tables);
  return {
    hash: note.content_hash,
    sourceType: note.source_type,
    sourceId: note.source_id,
    noteBytes: Buffer.byteLength(body),
    noteChars: body.length,
    lines: body.split('\n').length,
    paragraphChars: para?.value ?? 0,
    listItems: list?.value ?? 0,
    tableCells: table?.value ?? 0,
    blocks: {
      paragraphChars: para,
      listItems: list,
      tableCells: table,
      noteBytes: para ?? list ?? table,
    },
  };
}
export function summarize(records) {
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = records
        .map((r) => r[metric])
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      return [
        metric,
        {
          containingNotes: values.length,
          totalNotes: records.length,
          percentiles: Object.fromEntries(quantiles.map((q) => [`p${q}`, percentile(values, q)])),
        },
      ];
    }),
  );
}
export function select(records, notes, perQuantile = 3) {
  const byHash = new Map(notes.map((n) => [n.content_hash, n]));
  const picks = [];
  for (const metric of metrics) {
    const population = records
      .filter((r) => r[metric] > 0)
      .sort((a, b) => a[metric] - b[metric] || a.hash.localeCompare(b.hash));
    for (const q of quantiles) {
      const threshold = percentile(
        population.map((r) => r[metric]),
        q,
      );
      const candidates = [...population].sort(
        (a, b) =>
          Math.abs(a[metric] - threshold) - Math.abs(b[metric] - threshold) ||
          a.hash.localeCompare(b.hash),
      );
      let count = 0;
      for (const r of candidates) {
        const block = r.blocks[metric];
        if (!block?.ends.length) continue;
        const end = block.ends[Math.floor((block.ends.length - 1) / 2)];
        const note = byHash.get(r.hash);
        picks.push({
          label: `${metric}-p${q}-${r.hash.slice(0, 8)}`,
          metric,
          quantile: q,
          threshold,
          value: r[metric],
          hash: r.hash,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          sourceUrl: note.source_url,
          sourceByte: Buffer.byteLength(note.body.slice(0, end)),
          sourceUtf16: end,
          noteBytes: r.noteBytes,
          noteChars: r.noteChars,
          lines: r.lines,
          structure: { ...block, ends: undefined },
          cell: metric === 'tableCells',
          body: note.body,
        });
        if (++count >= (q === 100 ? 1 : perQuantile)) break;
      }
      if (!count) throw new Error(`No editable fixture for ${metric} p${q}`);
    }
  }
  return picks;
}
