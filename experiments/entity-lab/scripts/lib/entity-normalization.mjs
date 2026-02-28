import path from 'node:path';

const STOPWORDS = new Set(['the', 'a', 'an']);
const ORG_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'co', 'corp', 'corporation']);

export function buildNormalizedEntities(noteEntries, options = {}) {
  const fuzzyThreshold = Number.isFinite(options.fuzzyThreshold) ? options.fuzzyThreshold : 0.94;
  const lowConfidenceThreshold = Number.isFinite(options.lowConfidenceThreshold)
    ? options.lowConfidenceThreshold
    : 0.55;

  /** @type {Map<string, Array<any>>} */
  const entitiesByType = new Map();

  for (const noteEntry of noteEntries) {
    const noteId = noteEntry.noteId;
    const sourcePath = noteEntry.sourcePath;
    const title = noteEntry.title;
    const extractedEntities = noteEntry.extraction?.entities ?? [];

    for (const mention of extractedEntities) {
      const normalized = normalizeEntityName(mention.type, mention.name);
      if (!normalized.normalizedName) continue;

      if (!entitiesByType.has(mention.type)) {
        entitiesByType.set(mention.type, []);
      }
      const typeList = entitiesByType.get(mention.type);

      let canonical = typeList.find(item => item.normalizedName === normalized.normalizedName);
      let mergeMethod = 'exact';

      if (!canonical) {
        const fuzzyMatch = findFuzzyMatch(typeList, mention.type, normalized.normalizedName, mention.name, fuzzyThreshold);
        if (fuzzyMatch) {
          canonical = fuzzyMatch.entity;
          mergeMethod = 'fuzzy';
        }
      }

      if (!canonical) {
        canonical = {
          id: '',
          type: mention.type,
          name: mention.name,
          normalizedName: normalized.normalizedName,
          aliases: new Set([mention.name, ...mention.aliases]),
          mentionCount: 0,
          confidenceTotal: 0,
          notes: new Map(),
          mergeMethods: new Set(),
          mergeEvidence: [],
        };
        typeList.push(canonical);
      }

      canonical.mergeMethods.add(mergeMethod);
      if (mergeMethod === 'fuzzy') {
        canonical.mergeEvidence.push({
          from: mention.name,
          to: canonical.name,
          noteId,
          score: similarityScore(mention.name, canonical.name),
        });
      }

      canonical.aliases.add(mention.name);
      for (const alias of mention.aliases) canonical.aliases.add(alias);
      canonical.mentionCount += 1;
      canonical.confidenceTotal += mention.confidence;

      if (!canonical.notes.has(noteId)) {
        canonical.notes.set(noteId, {
          noteId,
          sourcePath,
          title,
          mentions: [],
        });
      }
      canonical.notes.get(noteId).mentions.push({
        rawName: mention.name,
        confidence: mention.confidence,
        evidence: mention.evidence,
        aliases: mention.aliases,
        mergeMethod,
      });
    }
  }

  const canonicalList = [];
  const usedIds = new Set();

  for (const typeList of entitiesByType.values()) {
    typeList.sort((a, b) => {
      const noteDiff = b.notes.size - a.notes.size;
      if (noteDiff !== 0) return noteDiff;
      return a.name.localeCompare(b.name);
    });

    for (const entity of typeList) {
      const sortedNotes = Array.from(entity.notes.values()).sort((a, b) => a.noteId.localeCompare(b.noteId));
      const aliases = Array.from(entity.aliases)
        .filter(alias => alias.toLowerCase() !== entity.name.toLowerCase())
        .sort((a, b) => a.localeCompare(b));
      const avgConfidence = entity.mentionCount ? entity.confidenceTotal / entity.mentionCount : 0;

      const baseId = `${entity.type}:${slugify(entity.normalizedName)}`;
      const id = uniqueId(baseId, usedIds);

      canonicalList.push({
        id,
        type: entity.type,
        name: entity.name,
        normalizedName: entity.normalizedName,
        aliases,
        noteCount: sortedNotes.length,
        mentionCount: entity.mentionCount,
        avgConfidence: round3(avgConfidence),
        mergeMethods: Array.from(entity.mergeMethods).sort(),
        mergeEvidence: entity.mergeEvidence,
        notes: sortedNotes,
      });
    }
  }

  canonicalList.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    return a.name.localeCompare(b.name);
  });

  const byNote = new Map();
  for (const entity of canonicalList) {
    for (const noteRef of entity.notes) {
      if (!byNote.has(noteRef.noteId)) {
        byNote.set(noteRef.noteId, {
          noteId: noteRef.noteId,
          sourcePath: noteRef.sourcePath,
          title: noteRef.title,
          entities: [],
        });
      }

      const noteEntry = byNote.get(noteRef.noteId);
      const avgForNote = noteRef.mentions.reduce((sum, mention) => sum + mention.confidence, 0) / noteRef.mentions.length;
      noteEntry.entities.push({
        entityId: entity.id,
        type: entity.type,
        name: entity.name,
        confidence: round3(avgForNote),
        mergeMethods: dedupe(noteRef.mentions.map(mention => mention.mergeMethod)),
      });
    }
  }

  const noteEntities = Array.from(byNote.values()).sort((a, b) => a.noteId.localeCompare(b.noteId));
  for (const note of noteEntities) {
    note.entities.sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      return a.name.localeCompare(b.name);
    });
  }

  const lowConfidenceMentions = [];
  for (const entity of canonicalList) {
    for (const noteRef of entity.notes) {
      for (const mention of noteRef.mentions) {
        if (mention.confidence < lowConfidenceThreshold) {
          lowConfidenceMentions.push({
            entityId: entity.id,
            type: entity.type,
            canonicalName: entity.name,
            noteId: noteRef.noteId,
            title: noteRef.title,
            sourcePath: noteRef.sourcePath,
            rawName: mention.rawName,
            confidence: mention.confidence,
            evidence: mention.evidence,
          });
        }
      }
    }
  }

  const riskyMerges = canonicalList
    .filter(entity => entity.mergeMethods.includes('fuzzy') || entity.aliases.length >= 5)
    .map(entity => ({
      entityId: entity.id,
      type: entity.type,
      name: entity.name,
      aliases: entity.aliases,
      noteCount: entity.noteCount,
      mergeMethods: entity.mergeMethods,
      mergeEvidence: entity.mergeEvidence,
    }));

  const nearDuplicates = findNearDuplicates(canonicalList, fuzzyThreshold);

  return {
    entities: canonicalList,
    noteEntities,
    review: {
      lowConfidenceMentions,
      riskyMerges,
      nearDuplicates,
    },
  };
}

function findFuzzyMatch(typeList, type, normalizedName, rawName, threshold) {
  let best = null;

  for (const candidate of typeList) {
    if (candidate.type !== type) continue;

    const score = similarityScore(normalizedName, candidate.normalizedName);
    if (score < threshold) continue;

    if (!passesFuzzyGuards(type, normalizedName, candidate.normalizedName)) continue;

    if (!best || score > best.score) {
      best = { entity: candidate, score };
    }
  }

  if (!best) return null;
  const selfScore = similarityScore(normalizedName, rawName.toLowerCase());
  if (selfScore < 0.5) return null;
  return best;
}

function findNearDuplicates(canonicalList, fuzzyThreshold) {
  const nearDuplicates = [];

  for (let i = 0; i < canonicalList.length; i += 1) {
    const a = canonicalList[i];
    for (let j = i + 1; j < canonicalList.length; j += 1) {
      const b = canonicalList[j];
      if (a.type !== b.type) continue;

      const score = similarityScore(a.normalizedName, b.normalizedName);
      if (score < 0.88 || score >= fuzzyThreshold) continue;

      if (!passesFuzzyGuards(a.type, a.normalizedName, b.normalizedName)) continue;

      nearDuplicates.push({
        type: a.type,
        entityA: { id: a.id, name: a.name, noteCount: a.noteCount },
        entityB: { id: b.id, name: b.name, noteCount: b.noteCount },
        score: round3(score),
      });
    }
  }

  nearDuplicates.sort((a, b) => b.score - a.score);
  return nearDuplicates.slice(0, 200);
}

export function normalizeEntityName(type, name) {
  const cleaned = (name ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { displayName: '', normalizedName: '' };
  }

  const tokens = cleaned
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  let normalizedTokens = tokens.filter(token => !STOPWORDS.has(token));

  if (type === 'organization') {
    normalizedTokens = normalizedTokens.filter(token => !ORG_SUFFIXES.has(token));
  }

  if (type === 'project') {
    if (normalizedTokens[0] === 'project') {
      normalizedTokens = normalizedTokens.slice(1);
    }
  }

  const normalizedName = normalizedTokens.join(' ').trim();
  return {
    displayName: cleaned,
    normalizedName,
  };
}

function passesFuzzyGuards(type, left, right) {
  if (!left || !right) return false;
  if (left === right) return true;

  const leftTokens = left.split(' ');
  const rightTokens = right.split(' ');

  if (Math.min(leftTokens.length, rightTokens.length) === 1) {
    if (type === 'person') return false;
    if (Math.min(left.length, right.length) < 5) return false;
  }

  const overlap = tokenOverlap(leftTokens, rightTokens);
  if (overlap < 0.5) return false;

  if (type === 'person') {
    const leftLast = leftTokens[leftTokens.length - 1];
    const rightLast = rightTokens[rightTokens.length - 1];
    if (leftLast !== rightLast) return false;

    const leftFirst = leftTokens[0];
    const rightFirst = rightTokens[0];
    if (leftFirst[0] !== rightFirst[0]) return false;
  }

  return true;
}

function tokenOverlap(aTokens, bTokens) {
  const aSet = new Set(aTokens);
  const bSet = new Set(bTokens);
  let shared = 0;
  for (const token of aSet) {
    if (bSet.has(token)) shared += 1;
  }
  return shared / Math.max(aSet.size, bSet.size);
}

function similarityScore(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const aBigrams = toBigrams(a);
  const bBigrams = toBigrams(b);

  if (aBigrams.length === 0 || bBigrams.length === 0) {
    return a === b ? 1 : 0;
  }

  const aMap = new Map();
  for (const token of aBigrams) {
    aMap.set(token, (aMap.get(token) ?? 0) + 1);
  }

  let overlap = 0;
  for (const token of bBigrams) {
    const count = aMap.get(token) ?? 0;
    if (count > 0) {
      overlap += 1;
      aMap.set(token, count - 1);
    }
  }

  return (2 * overlap) / (aBigrams.length + bBigrams.length);
}

function toBigrams(value) {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= 1) return [compact];
  const grams = [];
  for (let i = 0; i < compact.length - 1; i += 1) {
    grams.push(compact.slice(i, i + 2));
  }
  return grams;
}

function slugify(value) {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return base || 'entity';
}

function uniqueId(base, usedIds) {
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  let index = 2;
  while (usedIds.has(`${base}-${index}`)) {
    index += 1;
  }

  const next = `${base}-${index}`;
  usedIds.add(next);
  return next;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function dedupe(values) {
  return Array.from(new Set(values));
}

export function noteDisplayLabel(noteRef) {
  const filename = path.basename(noteRef.noteId);
  return filename.replace(/\.md$/i, '');
}
