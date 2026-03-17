import { UMAP } from 'umap-js';

export interface GraphNode {
  noteId: string;
  title: string;
  x: number;
  y: number;
  clusterId: string | null;
  clusterIndex: number;
}

export interface GraphCluster {
  id: string;
  label: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  noteIds: string[];
}

export interface GraphData {
  nodes: GraphNode[];
  clusters: GraphCluster[];
  nodeIndex: Map<string, number>;
}

export interface GraphClusterInput {
  noteId: string;
  title: string;
  preview: string;
  tags: string[];
  vector: number[];
  x: number;
  y: number;
}

export interface GraphVectorEntry {
  noteId: string;
  title: string;
  preview: string;
  tags: string[];
  vector: number[];
}

const GRAPH_LAYOUT_SEED = 0x51f15e77;
const CLUSTER_COLORS = [
  '#d96f32',
  '#4f8f87',
  '#b0533e',
  '#6a8a3a',
  '#4f73b8',
  '#b47b1f',
  '#8f5cb3',
  '#2c8f68',
  '#b84f7d',
  '#6e6ccf',
  '#9a6e43',
  '#477f9a',
];
const LABEL_STOPWORDS = new Set([
  'a',
  'about',
  'after',
  'again',
  'also',
  'an',
  'and',
  'another',
  'are',
  'around',
  'as',
  'at',
  'be',
  'been',
  'before',
  'being',
  'between',
  'by',
  'could',
  'demo',
  'does',
  'doing',
  'done',
  'each',
  'feel',
  'for',
  'from',
  'get',
  'got',
  'had',
  'has',
  'have',
  'here',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'kind',
  'like',
  'make',
  'maybe',
  'more',
  'much',
  'need',
  'note',
  'notes',
  'not',
  'of',
  'off',
  'on',
  'onto',
  'other',
  'our',
  'out',
  'over',
  'really',
  'same',
  'some',
  'still',
  'take',
  'that',
  'the',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'throughout',
  'to',
  'too',
  'under',
  'up',
  'using',
  'via',
  'very',
  'want',
  'was',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'your',
]);
const LABEL_LOW_SIGNAL_TOKENS = new Set([
  'chapter',
  'guide',
  'idea',
  'ideas',
  'intro',
  'introduction',
  'lesson',
  'list',
  'misc',
  'note',
  'notes',
  'part',
  'plan',
  'product',
  'question',
  'summary',
  'stuff',
  'thing',
  'things',
  'thought',
  'thoughts',
  'video',
]);
const GENERIC_LABELS = new Set([
  'all',
  'ana',
  'book',
  'budget',
  'hour',
  'learn',
  'option',
  'original',
]);
const DATE_TITLE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{2}-\d{2}-\d{4}$/,
  /^\d{1,2}-\d{1,2}-\d{4}$/,
];
const CATEGORY_RULES = [
  { label: 'Daily Notes', keywords: ['journal', 'today', 'week', 'weekly'], dateBias: 2.0 },
  { label: 'School', keywords: ['lesson', 'chapter', 'lecture', 'essay', 'prompt', 'assignment', 'his317l', 'soc', 'quiz', 'class', 'exam', 'unit'], dateBias: 0 },
  { label: 'Recipes', keywords: ['recipe', 'recipes', 'grocery', 'dinner', 'chicken', 'beef', 'roast', 'nihari', 'carnitas', 'alfredo', 'meal'], dateBias: 0 },
  { label: 'Reading', keywords: ['book', 'books', 'guide', 'handbook', 'summary', 'article', 'read', 'reading', 'lesswrong', 'author'], dateBias: 0 },
  { label: 'Work', keywords: ['call', 'meeting', 'follow', 'account', 'client', 'budget', 'project', 'design', 'story', 'stories', 'roadmap', 'compliance', 'pricing', 'management', 'task', 'tasks'], dateBias: 0 },
  { label: 'Projects', keywords: ['app', 'build', 'feature', 'option', 'brainstorm', 'startup', 'campaign', 'idea', 'ideas', 'problem', 'product', 'aggregate', 'link'], dateBias: 0 },
  { label: 'Media', keywords: ['album', 'movie', 'song', 'music', 'film', 'artist'], dateBias: 0 },
  { label: 'Writing', keywords: ['draft', 'writing', 'write', 'original', 'story', 'poem'], dateBias: 0 },
  { label: 'Lists', keywords: ['list', 'top', 'best', 'favorite', 'ways'], dateBias: 0 },
] as const;

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function squaredDistance(a: number[], b: number[]): number {
  let total = 0;
  const dims = Math.min(a.length, b.length);
  for (let i = 0; i < dims; i++) {
    const delta = a[i] - b[i];
    total += delta * delta;
  }
  return total;
}

function averageVector(entries: GraphClusterInput[], indices: number[], dims: number): number[] {
  const avg = new Array<number>(dims).fill(0);
  if (indices.length === 0) return avg;
  for (const index of indices) {
    const vector = entries[index].vector;
    for (let i = 0; i < dims; i++) {
      avg[i] += vector[i];
    }
  }
  for (let i = 0; i < dims; i++) {
    avg[i] /= indices.length;
  }
  return avg;
}

function determineClusterCount(noteCount: number): number {
  if (noteCount < 12) return Math.max(3, Math.min(noteCount, 4));
  const lowerBound = noteCount >= 400 ? 6 : 3;
  const hardUpperBound = noteCount >= 1500 ? 8 : noteCount >= 700 ? 8 : 12;
  const upperBound = Math.min(hardUpperBound, Math.max(lowerBound, Math.floor(noteCount / 12)));
  const suggested = Math.round(Math.sqrt(noteCount) / 3);
  return Math.max(lowerBound, Math.min(upperBound, suggested));
}

function normalizeToken(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleaned || /^\d+$/.test(cleaned) || LABEL_STOPWORDS.has(cleaned)) return '';
  if (cleaned.endsWith('ies') && cleaned.length > 4) return `${cleaned.slice(0, -3)}y`;
  if (cleaned.endsWith('s') && cleaned.length > 4 && !cleaned.endsWith('ss')) return cleaned.slice(0, -1);
  return cleaned;
}

function tokenizeText(text: string): string[] {
  const rawTokens = text.match(/[a-z0-9][a-z0-9-]*/gi) ?? [];
  const tokens: string[] = [];
  for (const raw of rawTokens) {
    const token = normalizeToken(raw);
    if (!token || token.length < 3) continue;
    tokens.push(token);
  }
  return tokens;
}

function titleCaseTerm(term: string): string {
  return term
    .split(/[\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function isMeaningfulLabelTerm(term: string): boolean {
  const words = term.split(/\s+/g).filter(Boolean);
  if (words.length === 0) return false;
  return words.some((word) => !LABEL_LOW_SIGNAL_TOKENS.has(word));
}

function isGenericLabel(label: string): boolean {
  const normalized = normalizeToken(label);
  return !normalized || GENERIC_LABELS.has(normalized) || LABEL_LOW_SIGNAL_TOKENS.has(normalized);
}

function looksNumericLabel(label: string): boolean {
  return /^\d+( \d+)+$/.test(label.trim());
}

function friendlyCategoryLabel(label: string): string {
  if (label === 'Daily Notes') return 'Journal';
  if (label === 'Projects') return 'Ideas';
  if (label === 'Lists') return 'Media';
  return label;
}

function categoryDisplayLabel(
  topCategory: { label: string; score: number; coverage: number },
  categoryScores: Array<{ label: string; score: number; coverage: number }>,
  clusterSize: number,
): string {
  const topLabel = friendlyCategoryLabel(topCategory.label);
  if (clusterSize < 180) return topLabel;

  const companion = categoryScores.find((candidate) => (
    candidate.label !== topCategory.label
    && candidate.score >= topCategory.score * 0.42
    && candidate.coverage >= Math.max(8, Math.ceil(clusterSize * 0.05))
    && !(topCategory.label !== 'Daily Notes' && candidate.label === 'Daily Notes')
  ));
  if (!companion) return topLabel;

  const companionLabel = friendlyCategoryLabel(companion.label);
  if (topLabel === companionLabel) return topLabel;
  return `${topLabel} & ${companionLabel}`;
}

function collectDocumentFrequencies(entries: GraphClusterInput[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const entry of entries) {
    const terms = new Set<string>();
    for (const tag of entry.tags) {
      const normalized = normalizeToken(tag.replace(/^#/, ''));
      if (normalized) terms.add(normalized);
    }
    const titleTokens = tokenizeText(entry.title);
    for (const token of titleTokens) {
      terms.add(token);
    }
    for (let i = 0; i < titleTokens.length - 1; i++) {
      terms.add(`${titleTokens[i]} ${titleTokens[i + 1]}`);
    }
    for (const term of terms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }
  return docFreq;
}

function buildClusterLabel(clusterEntries: GraphClusterInput[], docFreq: Map<string, number>, totalNotes: number): string {
  const tagCounts = new Map<string, number>();
  for (const entry of clusterEntries) {
    const uniqueTags = new Set(
      entry.tags
        .map((tag) => normalizeToken(tag.replace(/^#/, '')))
        .filter(Boolean),
    );
    for (const tag of uniqueTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const dominantTag = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (dominantTag && dominantTag[1] >= Math.max(3, Math.ceil(clusterEntries.length * 0.4))) {
    return titleCaseTerm(dominantTag[0]);
  }

  const categoryScores = CATEGORY_RULES.map((rule) => {
    let score = 0;
    let coverage = 0;
    for (const entry of clusterEntries) {
      const title = entry.title.toLowerCase();
      const titleTokens = new Set(tokenizeText(entry.title));
      let noteScore = 0;
      if (rule.dateBias > 0 && DATE_TITLE_PATTERNS.some((pattern) => pattern.test(entry.title))) {
        noteScore += rule.dateBias;
      }
      for (const keyword of rule.keywords) {
        if (titleTokens.has(keyword) || title.includes(keyword)) {
          noteScore += 1.2;
        }
      }
      if (noteScore > 0) {
        coverage += 1;
        score += noteScore;
      }
    }
    return { label: rule.label, score, coverage };
  }).sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.label.localeCompare(b.label));

  const topCategory = categoryScores[0];
  const secondCategory = categoryScores[1];
  if (
    topCategory
    && topCategory.coverage >= Math.max(2, Math.ceil(clusterEntries.length * 0.18))
    && topCategory.score >= Math.max(3.5, clusterEntries.length * 0.42)
    && (!secondCategory || topCategory.score >= secondCategory.score * 1.12)
  ) {
    return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
  }
  if (
    topCategory
    && clusterEntries.length >= 120
    && topCategory.score >= 14
    && (
      !secondCategory
      || topCategory.score >= secondCategory.score * 1.05
      || topCategory.coverage >= secondCategory.coverage * 1.2
    )
  ) {
    return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
  }

  const stats = new Map<string, { coverage: number; score: number }>();
  const minCoverage = clusterEntries.length <= 6
    ? 1
    : Math.max(2, Math.ceil(clusterEntries.length * 0.16));
  const minBigramCoverage = clusterEntries.length <= 8
    ? 1
    : Math.max(2, Math.ceil(clusterEntries.length * 0.22));

  for (const entry of clusterEntries) {
    const titleTokens = tokenizeText(entry.title);
    const titleBigrams = new Set<string>();
    for (let i = 0; i < titleTokens.length - 1; i++) {
      titleBigrams.add(`${titleTokens[i]} ${titleTokens[i + 1]}`);
    }

    const seenTerms = new Set<string>();
    const addTerm = (term: string, weight: number): void => {
      if (!term || !isMeaningfulLabelTerm(term)) return;
      const idf = Math.log(1 + (totalNotes / ((docFreq.get(term) ?? 0) + 1)));
      const current = stats.get(term) ?? { coverage: 0, score: 0 };
      current.score += weight * idf;
      if (!seenTerms.has(term)) {
        current.coverage += 1;
        seenTerms.add(term);
      }
      stats.set(term, current);
    };

    for (const token of titleTokens) addTerm(token, 1.5);
    for (const term of titleBigrams) addTerm(term, 2.15);
    for (const tag of entry.tags) {
      const normalized = normalizeToken(tag.replace(/^#/, ''));
      if (normalized) addTerm(normalized, 2.4);
    }
  }

  const ranked = Array.from(stats.entries())
    .map(([term, value]) => ({
      term,
      coverage: value.coverage,
      score: value.score * (1 + (value.coverage / Math.max(clusterEntries.length, 1))),
    }))
    .filter(({ term, coverage }) => (
      term.length >= 3
      && coverage >= (term.includes(' ') ? minBigramCoverage : minCoverage)
    ))
    .sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.term.localeCompare(b.term));

  if (ranked.length === 0) {
    const fallback = clusterEntries
      .map((entry) => tokenizeText(entry.title))
      .flat()
      .find((term) => !LABEL_LOW_SIGNAL_TOKENS.has(term));
    return fallback ? titleCaseTerm(fallback) : 'Notes';
  }

  const bestBigram = ranked.find(({ term }) => term.includes(' '));
  const bestToken = ranked.find(({ term }) => !term.includes(' '));

  if (bestBigram && (!bestToken || bestBigram.score > bestToken.score * 1.1)) {
    const label = titleCaseTerm(bestBigram.term);
    if ((isGenericLabel(label) || looksNumericLabel(label)) && topCategory && topCategory.score >= 2.5) {
      return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
    }
    return label;
  }

  if (!bestToken) {
    const label = titleCaseTerm(ranked[0].term);
    if ((isGenericLabel(label) || looksNumericLabel(label)) && topCategory && topCategory.score >= 2.5) {
      return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
    }
    return label;
  }

  const companion = ranked.find(({ term, score, coverage }) => (
    !term.includes(' ')
    && term !== bestToken.term
    && coverage >= minCoverage
    && score >= bestToken.score * 0.7
  ));

  if (companion && clusterEntries.length >= 10) {
    const label = titleCaseTerm(`${bestToken.term} ${companion.term}`);
    if ((isGenericLabel(label) || looksNumericLabel(label)) && topCategory && topCategory.score >= 2.5) {
      return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
    }
    return label;
  }

  const fallbackLabel = titleCaseTerm(bestToken.term);
  if (
    topCategory
    && topCategory.score >= 2.5
    && (
      isGenericLabel(fallbackLabel)
      || looksNumericLabel(fallbackLabel)
      || (clusterEntries.length >= 80 && !fallbackLabel.includes(' '))
    )
  ) {
    return categoryDisplayLabel(topCategory, categoryScores, clusterEntries.length);
  }

  return fallbackLabel;
}

function kMeans(entries: GraphClusterInput[], clusterCount: number): number[] {
  const dims = entries[0]?.vector.length ?? 0;
  const random = createSeededRandom(GRAPH_LAYOUT_SEED ^ entries.length);
  const centroids: number[][] = [];

  let nextIndex = Math.floor(random() * entries.length);
  centroids.push(entries[nextIndex].vector.slice());
  while (centroids.length < clusterCount) {
    let farthestIndex = 0;
    let farthestDistance = -1;
    for (let i = 0; i < entries.length; i++) {
      let nearest = Infinity;
      for (const centroid of centroids) {
        nearest = Math.min(nearest, squaredDistance(entries[i].vector, centroid));
      }
      if (nearest > farthestDistance) {
        farthestDistance = nearest;
        farthestIndex = i;
      }
    }
    centroids.push(entries[farthestIndex].vector.slice());
  }

  const assignments = new Array<number>(entries.length).fill(0);
  for (let iter = 0; iter < 24; iter++) {
    let changed = false;
    for (let i = 0; i < entries.length; i++) {
      let bestIndex = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const distance = squaredDistance(entries[i].vector, centroids[c]);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = c;
        }
      }
      if (assignments[i] !== bestIndex) {
        assignments[i] = bestIndex;
        changed = true;
      }
    }

    const buckets = new Map<number, number[]>();
    for (let i = 0; i < assignments.length; i++) {
      const bucket = buckets.get(assignments[i]) ?? [];
      bucket.push(i);
      buckets.set(assignments[i], bucket);
    }

    for (let c = 0; c < centroids.length; c++) {
      const indices = buckets.get(c);
      if (!indices || indices.length === 0) {
        nextIndex = Math.floor(random() * entries.length);
        centroids[c] = entries[nextIndex].vector.slice();
        continue;
      }
      centroids[c] = averageVector(entries, indices, dims);
    }

    if (!changed) break;
  }

  return assignments;
}

export function buildGraphClusters(entries: GraphClusterInput[]): GraphCluster[] {
  if (entries.length === 0) return [];
  const clusterCount = determineClusterCount(entries.length);
  const assignments = kMeans(entries, Math.min(clusterCount, entries.length));
  const docFreq = collectDocumentFrequencies(entries);
  const buckets = new Map<number, GraphClusterInput[]>();

  for (let i = 0; i < assignments.length; i++) {
    const bucket = buckets.get(assignments[i]) ?? [];
    bucket.push(entries[i]);
    buckets.set(assignments[i], bucket);
  }

  const clusters: GraphCluster[] = Array.from(buckets.entries())
    .map(([clusterIndex, clusterEntries]) => {
      const x = clusterEntries.reduce((sum, entry) => sum + entry.x, 0) / clusterEntries.length;
      const y = clusterEntries.reduce((sum, entry) => sum + entry.y, 0) / clusterEntries.length;
      const radius = Math.max(
        48,
        ...clusterEntries.map((entry) => Math.hypot(entry.x - x, entry.y - y) + 24),
      );
      return {
        id: `cluster-${clusterIndex}`,
        label: buildClusterLabel(clusterEntries, docFreq, entries.length),
        x,
        y,
        radius,
        color: CLUSTER_COLORS[clusterIndex % CLUSTER_COLORS.length],
        noteIds: clusterEntries.map((entry) => entry.noteId),
      };
    })
    .sort((a, b) => b.noteIds.length - a.noteIds.length || a.label.localeCompare(b.label));

  return clusters.map((cluster, index) => ({
    ...cluster,
    id: `cluster-${index}`,
    color: CLUSTER_COLORS[index % CLUSTER_COLORS.length],
  }));
}

export function buildGraphDataFromEntries(entries: GraphVectorEntry[]): GraphData {
  if (entries.length < 2) {
    throw new Error('Need at least 2 matched notes for graph');
  }

  const vectors = entries.map((entry) => entry.vector);
  const nNeighbors = Math.min(15, Math.max(2, vectors.length - 1));
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: 0.1,
    random: createSeededRandom(GRAPH_LAYOUT_SEED ^ entries.length),
  });
  const coords = umap.fit(vectors);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const coord of coords) {
    if (coord[0] < xMin) xMin = coord[0];
    if (coord[0] > xMax) xMax = coord[0];
    if (coord[1] < yMin) yMin = coord[1];
    if (coord[1] > yMax) yMax = coord[1];
  }
  const xRange = xMax - xMin || 1;
  const yRange = yMax - yMin || 1;
  const halfRange = Math.max(150, Math.sqrt(entries.length) * 35);

  const graphEntries: GraphClusterInput[] = [];
  for (let i = 0; i < entries.length; i++) {
    const x = ((coords[i][0] - xMin) / xRange) * halfRange * 2 - halfRange;
    const y = ((coords[i][1] - yMin) / yRange) * halfRange * 2 - halfRange;
    graphEntries.push({
      noteId: entries[i].noteId,
      title: entries[i].title,
      preview: entries[i].preview,
      tags: entries[i].tags,
      vector: entries[i].vector,
      x,
      y,
    });
  }

  const minDist = 12;
  const cellSize = minDist;
  const jitterRandom = createSeededRandom(GRAPH_LAYOUT_SEED ^ (entries.length << 4));
  for (let iter = 0; iter < 50; iter++) {
    let moved = false;
    const grid = new Map<string, number[]>();

    for (let i = 0; i < graphEntries.length; i++) {
      const cx = Math.floor(graphEntries[i].x / cellSize);
      const cy = Math.floor(graphEntries[i].y / cellSize);
      const key = `${cx},${cy}`;
      const bucket = grid.get(key) ?? [];
      bucket.push(i);
      grid.set(key, bucket);
    }

    for (const [key, indices] of grid) {
      const [cx, cy] = key.split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const neighbor = grid.get(`${cx + dx},${cy + dy}`);
          if (!neighbor) continue;
          for (const i of indices) {
            for (const j of neighbor) {
              if (j <= i) continue;
              const ddx = graphEntries[j].x - graphEntries[i].x;
              const ddy = graphEntries[j].y - graphEntries[i].y;
              const dist = Math.sqrt(ddx * ddx + ddy * ddy);
              if (dist < minDist) {
                if (dist > 0) {
                  const overlap = (minDist - dist) / 2;
                  const nx = ddx / dist;
                  const ny = ddy / dist;
                  graphEntries[i].x -= nx * overlap;
                  graphEntries[i].y -= ny * overlap;
                  graphEntries[j].x += nx * overlap;
                  graphEntries[j].y += ny * overlap;
                } else {
                  graphEntries[j].x += (jitterRandom() - 0.5) * minDist;
                  graphEntries[j].y += (jitterRandom() - 0.5) * minDist;
                }
                moved = true;
              }
            }
          }
        }
      }
    }

    if (!moved) break;
  }

  const clusters = buildGraphClusters(graphEntries);
  const clusterByNoteId = new Map<string, { id: string; index: number }>();
  for (let i = 0; i < clusters.length; i++) {
    for (const noteId of clusters[i].noteIds) {
      clusterByNoteId.set(noteId, { id: clusters[i].id, index: i });
    }
  }

  const nodes: GraphNode[] = [];
  const nodeIndex = new Map<string, number>();
  for (const entry of graphEntries) {
    const cluster = clusterByNoteId.get(entry.noteId);
    nodeIndex.set(entry.noteId, nodes.length);
    nodes.push({
      noteId: entry.noteId,
      title: entry.title,
      x: entry.x,
      y: entry.y,
      clusterId: cluster?.id ?? null,
      clusterIndex: cluster?.index ?? -1,
    });
  }

  return { nodes, clusters, nodeIndex };
}
