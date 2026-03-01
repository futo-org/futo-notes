#!/usr/bin/env node

/**
 * Phase 2: Consolidate raw tags into a canonical taxonomy.
 * - Counts tag frequency across all notes
 * - Merges near-duplicates (fuzzy match)
 * - Prunes tags that appear on fewer than --min-count notes (default: 2)
 * - Writes canonical tag list to cache/tag-taxonomy.json
 */

import path from 'node:path';
import { CACHE_DIR } from './lib/constants.mjs';
import { readJsonFile, writeJsonFile } from './lib/fs-utils.mjs';

const args = parseArgs(process.argv.slice(2));
const minCount = args.minCount > 0 ? args.minCount : 2;
const fuzzyThreshold = args.fuzzyThreshold > 0 ? args.fuzzyThreshold : 0.85;

const discoverPath = path.resolve(args.discoverFile || path.join(CACHE_DIR, 'tag-discover.json'));
const taxonomyPath = path.resolve(args.taxonomyFile || path.join(CACHE_DIR, 'tag-taxonomy.json'));

const discover = await readJsonFile(discoverPath);
if (!discover?.notes || typeof discover.notes !== 'object') {
  console.error('[tag-consolidate] No discovery data found. Run tag-discover first.');
  process.exit(1);
}

// Count raw tag frequencies
const tagCounts = new Map();
const tagNotes = new Map();

for (const [noteId, entry] of Object.entries(discover.notes)) {
  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  for (const tag of tags) {
    const key = tag.toLowerCase().trim();
    if (!key) continue;
    tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    if (!tagNotes.has(key)) tagNotes.set(key, []);
    tagNotes.get(key).push(noteId);
  }
}

console.log(`[tag-consolidate] raw unique tags: ${tagCounts.size}`);

// Merge near-duplicates using normalized Levenshtein
const sortedTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]);
const mergeMap = new Map(); // from -> to (canonical)
const canonical = new Map(); // canonical tag -> count

for (const [tag, count] of sortedTags) {
  if (mergeMap.has(tag)) continue;

  // Check if this tag is similar to an existing canonical tag
  let merged = false;
  for (const [canonTag] of canonical) {
    if (similarity(tag, canonTag) >= fuzzyThreshold) {
      // Merge into the higher-count canonical
      mergeMap.set(tag, canonTag);
      canonical.set(canonTag, canonical.get(canonTag) + count);
      // Merge note lists
      const notes = tagNotes.get(tag) || [];
      const canonNotes = tagNotes.get(canonTag) || [];
      tagNotes.set(canonTag, [...new Set([...canonNotes, ...notes])]);
      merged = true;
      break;
    }
  }

  if (!merged) {
    canonical.set(tag, count);
    mergeMap.set(tag, tag);
  }
}

console.log(`[tag-consolidate] after merge: ${canonical.size} canonical tags`);

// Prune tags below min count
const pruned = [];
const kept = [];
for (const [tag, count] of canonical) {
  if (count < minCount) {
    pruned.push({ tag, count });
  } else {
    kept.push({ tag, count, notes: tagNotes.get(tag) || [] });
  }
}

kept.sort((a, b) => b.count - a.count);

console.log(`[tag-consolidate] pruned ${pruned.length} tags with count < ${minCount}`);
console.log(`[tag-consolidate] final taxonomy: ${kept.length} tags`);
console.log('');

for (const { tag, count } of kept) {
  console.log(`  ${tag} (${count} notes)`);
}

const taxonomy = {
  version: 1,
  createdAt: new Date().toISOString(),
  minCount,
  fuzzyThreshold,
  tags: kept.map(({ tag, count, notes }) => ({ tag, count, notes })),
  pruned: pruned.map(({ tag, count }) => ({ tag, count })),
  mergeMap: Object.fromEntries(mergeMap),
};

await writeJsonFile(taxonomyPath, taxonomy);
console.log(`\n[tag-consolidate] wrote ${taxonomyPath}`);

// --- helpers ---

function similarity(a, b) {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const dist = levenshtein(longer, shorter);
  return (longer.length - dist) / longer.length;
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[b.length][a.length];
}

function parseArgs(argv) {
  const out = { discoverFile: '', taxonomyFile: '', minCount: 0, fuzzyThreshold: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--discover-file') { out.discoverFile = argv[++i] ?? ''; continue; }
    if (arg === '--taxonomy-file') { out.taxonomyFile = argv[++i] ?? ''; continue; }
    if (arg === '--min-count') { out.minCount = Number(argv[++i] ?? '0'); continue; }
    if (arg === '--fuzzy-threshold') { out.fuzzyThreshold = Number(argv[++i] ?? '0'); continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}
