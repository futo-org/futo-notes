#!/usr/bin/env node

/**
 * Phase 2: Consolidate discovered tags into a hierarchical taxonomy.
 * - Groups specific tags under their broad categories
 * - Merges near-duplicate categories and tags (fuzzy match)
 * - Prunes tags that appear on fewer than --min-count notes (default: 2)
 * - Writes hierarchical taxonomy to cache/tag-taxonomy.json
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

// Collect categories and tags
const catCounts = new Map();       // category -> count
const catMergeMap = new Map();     // raw category -> canonical category
const tagData = new Map();         // "category::tag" -> { count, notes[] }

for (const [noteId, entry] of Object.entries(discover.notes)) {
  const rawCat = typeof entry.category === 'string' ? entry.category.trim().toLowerCase() : '';
  if (!rawCat) continue;

  catCounts.set(rawCat, (catCounts.get(rawCat) || 0) + 1);

  const tags = Array.isArray(entry.tags) ? entry.tags : [];
  for (const tag of tags) {
    const key = `${rawCat}::${tag}`;
    if (!tagData.has(key)) tagData.set(key, { count: 0, notes: [] });
    const td = tagData.get(key);
    td.count++;
    td.notes.push(noteId);
  }
}

console.log(`[tag-consolidate] raw categories: ${catCounts.size}`);
console.log(`[tag-consolidate] raw unique tags: ${tagData.size}`);

// Merge near-duplicate categories
const sortedCats = [...catCounts.entries()].sort((a, b) => b[1] - a[1]);
const canonicalCats = new Map(); // canonical cat -> total count

for (const [cat, count] of sortedCats) {
  if (catMergeMap.has(cat)) continue;

  let merged = false;
  for (const [canonCat] of canonicalCats) {
    if (similarity(cat, canonCat) >= fuzzyThreshold) {
      catMergeMap.set(cat, canonCat);
      canonicalCats.set(canonCat, canonicalCats.get(canonCat) + count);
      merged = true;
      break;
    }
  }

  if (!merged) {
    canonicalCats.set(cat, count);
    catMergeMap.set(cat, cat);
  }
}

console.log(`[tag-consolidate] after category merge: ${canonicalCats.size} categories`);

// Rebuild tag data under canonical categories, merging near-duplicate tags within each category
const categoryTags = new Map(); // canonical cat -> Map<canonical tag, { count, notes[] }>

for (const [key, data] of tagData) {
  const [rawCat, tag] = key.split('::');
  const canonCat = catMergeMap.get(rawCat) || rawCat;

  if (!categoryTags.has(canonCat)) categoryTags.set(canonCat, new Map());
  const tagMap = categoryTags.get(canonCat);

  // Find existing similar tag in this category
  let mergedInto = null;
  for (const [existingTag] of tagMap) {
    if (similarity(tag, existingTag) >= fuzzyThreshold) {
      mergedInto = existingTag;
      break;
    }
  }

  if (mergedInto) {
    const existing = tagMap.get(mergedInto);
    existing.count += data.count;
    existing.notes = [...new Set([...existing.notes, ...data.notes])];
  } else {
    tagMap.set(tag, { count: data.count, notes: [...data.notes] });
  }
}

// Build final taxonomy: prune low-count tags, sort
const taxonomy = {
  version: 2,
  createdAt: new Date().toISOString(),
  minCount,
  fuzzyThreshold,
  categories: [],
  catMergeMap: Object.fromEntries(catMergeMap),
};

let totalKept = 0;
let totalPruned = 0;

const sortedCanonCats = [...canonicalCats.entries()].sort((a, b) => b[1] - a[1]);

for (const [cat, catCount] of sortedCanonCats) {
  const tagMap = categoryTags.get(cat) || new Map();
  const kept = [];
  const pruned = [];

  for (const [tag, data] of tagMap) {
    if (data.count < minCount) {
      pruned.push({ tag, count: data.count });
      totalPruned++;
    } else {
      kept.push({ tag, count: data.count, notes: data.notes });
      totalKept++;
    }
  }

  kept.sort((a, b) => b.count - a.count);

  taxonomy.categories.push({
    category: cat,
    noteCount: catCount,
    tags: kept,
    pruned,
  });
}

console.log(`[tag-consolidate] kept ${totalKept} tags, pruned ${totalPruned} with count < ${minCount}`);
console.log('');

for (const cat of taxonomy.categories) {
  const tagList = cat.tags.map(t => `${t.tag}(${t.count})`).join(', ');
  console.log(`  ${cat.category} (${cat.noteCount} notes): ${tagList}`);
}

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
