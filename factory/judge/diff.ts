import type { DriverState, DecoratedRange, Position } from '../driver/protocol';

export interface Divergence {
  kind:
    | 'doc-mismatch'
    | 'cursor-drift'
    | 'selection-drift'
    | 'visible-text-drift'
    | 'decoration-only-in-futo-notes'
    | 'decoration-only-in-obsidian'
    | 'decoration-range-mismatch'
    // SF-only geometric/computed-style assertion failed. These don't
    // compare to Obsidian — they're absolute UX guarantees on the
    // FUTO Notes editor (cursor must clear the bullet, headings must
    // shrink monotonically, etc.). See factory/judge/layoutInvariants.ts.
    | 'layout-violation'
    // Pixel diff between SF and OB screenshots exceeded tolerance
    // after the neutral theme was injected. See visualDiff.ts.
    | 'visual-divergence';
  detail: string;
  // Optional structured payload for the report.
  data?: any;
}

function posEq(a: Position, b: Position): boolean {
  return a.line === b.line && a.ch === b.ch;
}

// Bucket decorations by their semantic kind, then for each kind compute
// the symmetric difference of (from,to) ranges. This avoids penalizing
// decorations that arrive in different DOM order.
function bucketByKind(decs: DecoratedRange[]): Map<string, DecoratedRange[]> {
  const m = new Map<string, DecoratedRange[]>();
  for (const d of decs) {
    if (d.kind === 'unknown') continue; // surfaced via classes-only divergence elsewhere if useful
    if (!m.has(d.kind)) m.set(d.kind, []);
    m.get(d.kind)!.push(d);
  }
  return m;
}

// Doc-position coverage of a list of ranges. For zero-width ranges
// (widget points), include the single position so widget-vs-widget
// comparison still works.
function coverageOf(ranges: DecoratedRange[]): Set<number> {
  const out = new Set<number>();
  for (const r of ranges) {
    if (r.from.pos === r.to.pos) {
      out.add(r.from.pos);
      continue;
    }
    for (let p = r.from.pos; p < r.to.pos; p++) out.add(p);
  }
  return out;
}

function setDiff(a: Set<number>, b: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

// Compact run-length description of a covered set, for the diff detail
// line. e.g. {1,2,3,7,8} → "1..4, 7..9".
function describeCoverage(positions: Set<number>): string {
  const sorted = [...positions].sort((a, b) => a - b);
  const runs: string[] = [];
  let i = 0;
  while (i < sorted.length && runs.length < 3) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(sorted[i] === sorted[j] ? `${sorted[i]}` : `${sorted[i]}..${sorted[j] + 1}`);
    i = j + 1;
  }
  if (i < sorted.length) runs.push('…');
  return runs.join(', ');
}

// Reduce innerText to its sequence of word tokens. Two editors that render
// the same source should produce the same word sequence; differences in
// markdown markers, widget glyphs, whitespace, and inline-vs-block layout
// drop out of the comparison while real content drift (a heading title
// being hidden, a code block losing its language label, etc.) survives.
function normalizeVisible(s: string): string {
  // Split letter and digit runs separately so OB's inline rendering
  // ("ordered2") tokenizes the same as SF's block rendering
  // ("ordered\n2"). Punctuation and widget glyphs (•◦▪) are dropped
  // entirely — they vary by editor decoration strategy and don't
  // correspond to source content.
  return (s.match(/[A-Za-z]+|[0-9]+/g) ?? []).join(' ');
}

export function diffStates(futoNotes: DriverState, obsidian: DriverState): Divergence[] {
  const out: Divergence[] = [];

  if (futoNotes.doc !== obsidian.doc) {
    out.push({
      kind: 'doc-mismatch',
      detail: `documents differ (futoNotes=${futoNotes.doc.length}b, obsidian=${obsidian.doc.length}b)`,
    });
  }
  if (!posEq(futoNotes.cursor, obsidian.cursor)) {
    out.push({
      kind: 'cursor-drift',
      detail: `futoNotes=(${futoNotes.cursor.line},${futoNotes.cursor.ch}) obsidian=(${obsidian.cursor.line},${obsidian.cursor.ch})`,
      data: { futoNotes: futoNotes.cursor, obsidian: obsidian.cursor },
    });
  }
  if (
    !posEq(futoNotes.selection.head, obsidian.selection.head) ||
    !posEq(futoNotes.selection.anchor, obsidian.selection.anchor)
  ) {
    out.push({
      kind: 'selection-drift',
      detail: 'selection range differs',
      data: { futoNotes: futoNotes.selection, obsidian: obsidian.selection },
    });
  }
  // innerText comparison is brittle across editors that decorate the same
  // doc with different DOM strategies (SF replaces `- ` with a `•` widget;
  // Obsidian leaves the markdown text and styles via CSS). Both render
  // visually similarly, but the raw innerText diverges. Normalize away
  // the easy false-positives before flagging.
  if (normalizeVisible(futoNotes.visibleText) !== normalizeVisible(obsidian.visibleText)) {
    out.push({
      kind: 'visible-text-drift',
      detail: 'visible text (innerText of .cm-content) differs after normalization',
      data: {
        futoNotes: futoNotes.visibleText,
        obsidian: obsidian.visibleText,
      },
    });
  }

  // Coverage-based comparison: for each kind, build a set of document
  // positions covered by any decoration of that kind. Two editors agree
  // when the position sets are equal — independent of whether one
  // emitted a single span and the other split it around a nested
  // decoration. This is what matters semantically: same characters,
  // same kind. Range identity is an artifact of decoration emission.
  const sfByKind = bucketByKind(futoNotes.decorations);
  const obByKind = bucketByKind(obsidian.decorations);
  const allKinds = new Set([...sfByKind.keys(), ...obByKind.keys()]);
  for (const kind of allKinds) {
    const sfCov = coverageOf(sfByKind.get(kind) ?? []);
    const obCov = coverageOf(obByKind.get(kind) ?? []);
    const onlySf = setDiff(sfCov, obCov);
    const onlyOb = setDiff(obCov, sfCov);
    if (onlySf.size > 0) {
      out.push({
        kind: 'decoration-only-in-futo-notes',
        detail: `${kind}: ${onlySf.size} char(s) covered only in futo-notes (e.g. ${describeCoverage(onlySf)})`,
        data: { kind, positions: [...onlySf].sort((a, b) => a - b) },
      });
    }
    if (onlyOb.size > 0) {
      out.push({
        kind: 'decoration-only-in-obsidian',
        detail: `${kind}: ${onlyOb.size} char(s) covered only in obsidian (e.g. ${describeCoverage(onlyOb)})`,
        data: { kind, positions: [...onlyOb].sort((a, b) => a - b) },
      });
    }
  }

  return out;
}

export interface ScenarioReport {
  name: string;
  complexity: number;
  satisfaction: number; // 1.0 = exact match, 0 otherwise (binary for now)
  divergences: Divergence[];
  futoNotes?: DriverState;
  obsidian?: DriverState;
  error?: string;
}

export function summarize(reports: ScenarioReport[]) {
  const total = reports.length;
  const passed = reports.filter((r) => r.divergences.length === 0 && !r.error).length;
  const errored = reports.filter((r) => r.error).length;
  const satisfaction = total === 0 ? 0 : passed / total;
  const buckets: Record<string, number> = {};
  for (const r of reports) {
    for (const d of r.divergences) buckets[d.kind] = (buckets[d.kind] ?? 0) + 1;
  }
  return { total, passed, errored, satisfaction, buckets };
}
