import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

export const CORPUS_CONSTRUCTS = [
  'dataview',
  'callout',
  'footnote',
  'embedded-html',
  'frontmatter',
  'math',
  'table',
  'wikilink-embed',
  'fenced-code',
  'task-list',
  'nested-list',
  'wikilink',
  'markdown-link',
  'heading',
  'blockquote',
  'inline-code',
  'emphasis',
  'list',
  'plain',
] as const;

export type CorpusConstruct = (typeof CORPUS_CONSTRUCTS)[number];

export interface CorpusScenario {
  name: string;
  markdown: string;
  complexity: number;
  construct: CorpusConstruct;
}

export interface CorpusSampleStats {
  recordsSeen: number;
  usableNotes: number;
  oversizedNotesSkipped: number;
  malformedRecords: number;
  missingBodies: number;
  piiFlaggedSkipped: number;
  matchedConstructCounts: Record<CorpusConstruct, number>;
  primaryConstructCounts: Record<CorpusConstruct, number>;
  sampledByConstruct: Record<CorpusConstruct, number>;
}

export interface CorpusSampleResult {
  scenarios: CorpusScenario[];
  stats: CorpusSampleStats;
}

export interface CorpusSampleOptions {
  size: number;
  seed: number;
  maxBodyLines?: number;
  maxBodyChars?: number;
}

interface CorpusRecord {
  body?: unknown;
  pii_flag?: unknown;
}

interface ClassifiedBody {
  matches: Array<{ construct: CorpusConstruct; index: number }>;
  primary: CorpusConstruct;
}

interface Reservoir {
  seen: number;
  rng: () => number;
  scenarios: Omit<CorpusScenario, 'name'>[];
}

const CONSTRUCT_PATTERNS: ReadonlyArray<{
  construct: Exclude<CorpusConstruct, 'plain'>;
  pattern: RegExp;
}> = [
  { construct: 'dataview', pattern: /^\s*```(?:dataview|dataviewjs)\b/im },
  { construct: 'callout', pattern: /^\s*>\s*\[![^\]\n]+\]/im },
  { construct: 'footnote', pattern: /(?:^\s*\[\^[^\]\n]+\]:|\[\^[^\]\n]+\])/m },
  { construct: 'embedded-html', pattern: /<\/?[a-z][^>\n]*>/i },
  { construct: 'frontmatter', pattern: /^---\s*\n[\s\S]*?\n---\s*(?:\n|$)/ },
  { construct: 'math', pattern: /(?:^\s*\$\$\s*$|\$[^$\n]+\$)/m },
  {
    construct: 'table',
    pattern: /^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*\|/m,
  },
  { construct: 'wikilink-embed', pattern: /!\[\[[^\]\n]+\]\]/ },
  { construct: 'fenced-code', pattern: /^\s*(?:```|~~~)/m },
  { construct: 'task-list', pattern: /^\s*[-+*]\s+\[[ xX]\]\s+/m },
  { construct: 'nested-list', pattern: /^(?: {2,}|\t+)\s*(?:[-+*]|\d+[.)])\s+/m },
  { construct: 'wikilink', pattern: /\[\[[^\]\n]+\]\]/ },
  { construct: 'markdown-link', pattern: /!?\[[^\]\n]+\]\([^\n)]+\)/ },
  { construct: 'heading', pattern: /^ {0,3}#{1,6}\s+/m },
  { construct: 'blockquote', pattern: /^ {0,3}>\s?/m },
  { construct: 'inline-code', pattern: /`[^`\n]+`/ },
  { construct: 'emphasis', pattern: /(?:\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*)/ },
  { construct: 'list', pattern: /^\s*(?:[-+*]|\d+[.)])\s+/m },
];

function emptyCounts(): Record<CorpusConstruct, number> {
  return Object.fromEntries(CORPUS_CONSTRUCTS.map((construct) => [construct, 0])) as Record<
    CorpusConstruct,
    number
  >;
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function hashConstruct(construct: CorpusConstruct): number {
  let hash = 0x811c9dc5;
  for (const char of construct) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function classifyBody(body: string): ClassifiedBody {
  const matches = CONSTRUCT_PATTERNS.flatMap(({ construct, pattern }) => {
    const match = pattern.exec(body);
    return match ? [{ construct, index: match.index }] : [];
  });
  if (matches.length === 0) {
    return { matches: [{ construct: 'plain', index: 0 }], primary: 'plain' };
  }
  return { matches, primary: matches[0].construct };
}

function addToReservoir(
  reservoir: Reservoir,
  scenario: Omit<CorpusScenario, 'name'>,
  capacity: number,
): void {
  reservoir.seen += 1;
  if (reservoir.scenarios.length < capacity) {
    reservoir.scenarios.push(scenario);
    return;
  }
  const slot = Math.floor(reservoir.rng() * reservoir.seen);
  if (slot < capacity) reservoir.scenarios[slot] = scenario;
}

function shuffleReservoir(reservoir: Reservoir): void {
  for (let index = reservoir.scenarios.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(reservoir.rng() * (index + 1));
    [reservoir.scenarios[index], reservoir.scenarios[swap]] = [
      reservoir.scenarios[swap],
      reservoir.scenarios[index],
    ];
  }
}

function parseRecord(line: string): CorpusRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as CorpusRecord) : null;
  } catch {
    return null;
  }
}

export async function sampleCorpusScenarios(
  corpusPath: string,
  { size, seed, maxBodyLines = 120, maxBodyChars = 8_000 }: CorpusSampleOptions,
): Promise<CorpusSampleResult> {
  if (!Number.isInteger(size) || size <= 0) throw new Error('corpus sample size must be positive');
  if (!Number.isInteger(maxBodyLines) || maxBodyLines <= 0) {
    throw new Error('corpus maximum line count must be positive');
  }
  if (!Number.isInteger(maxBodyChars) || maxBodyChars <= 0) {
    throw new Error('corpus maximum character count must be positive');
  }

  const stats: CorpusSampleStats = {
    recordsSeen: 0,
    usableNotes: 0,
    oversizedNotesSkipped: 0,
    malformedRecords: 0,
    missingBodies: 0,
    piiFlaggedSkipped: 0,
    matchedConstructCounts: emptyCounts(),
    primaryConstructCounts: emptyCounts(),
    sampledByConstruct: emptyCounts(),
  };
  const reservoirs = new Map<CorpusConstruct, Reservoir>();
  for (const construct of CORPUS_CONSTRUCTS) {
    reservoirs.set(construct, {
      seen: 0,
      rng: makeRng(seed ^ hashConstruct(construct)),
      scenarios: [],
    });
  }

  const file = createReadStream(corpusPath);
  const input = corpusPath.endsWith('.gz') ? file.pipe(createGunzip()) : file;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.trim().length === 0) continue;
      stats.recordsSeen += 1;
      const record = parseRecord(line);
      if (!record) {
        stats.malformedRecords += 1;
        continue;
      }
      if (record.pii_flag === 1 || record.pii_flag === true) {
        stats.piiFlaggedSkipped += 1;
        continue;
      }
      if (typeof record.body !== 'string' || record.body.trim().length === 0) {
        stats.missingBodies += 1;
        continue;
      }
      const bodyLines = record.body.split('\n').length;
      if (record.body.length > maxBodyChars || bodyLines > maxBodyLines) {
        stats.oversizedNotesSkipped += 1;
        continue;
      }

      stats.usableNotes += 1;
      const classified = classifyBody(record.body);
      for (const match of classified.matches) stats.matchedConstructCounts[match.construct] += 1;
      stats.primaryConstructCounts[classified.primary] += 1;
      addToReservoir(
        reservoirs.get(classified.primary)!,
        {
          markdown: record.body,
          complexity: classified.matches.length,
          construct: classified.primary,
        },
        size,
      );
    }
  } finally {
    lines.close();
    file.destroy();
  }

  const active = CORPUS_CONSTRUCTS.filter(
    (construct) => reservoirs.get(construct)!.scenarios.length > 0,
  );
  for (const construct of active) shuffleReservoir(reservoirs.get(construct)!);
  const scenarios: CorpusScenario[] = [];
  for (let round = 0; scenarios.length < size; round += 1) {
    let added = false;
    for (const construct of active) {
      const candidate = reservoirs.get(construct)!.scenarios[round];
      if (!candidate) continue;
      const ordinal = stats.sampledByConstruct[construct] + 1;
      stats.sampledByConstruct[construct] = ordinal;
      scenarios.push({
        ...candidate,
        name: `corpus-${construct}-${String(ordinal).padStart(3, '0')}`,
      });
      added = true;
      if (scenarios.length === size) break;
    }
    if (!added) break;
  }

  return { scenarios, stats };
}
