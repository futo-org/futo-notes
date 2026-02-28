import { ENTITY_TYPES, clamp01 } from './constants.mjs';

const ENTITY_TYPE_SET = new Set(ENTITY_TYPES);

export function buildUserPrompt(template, title, content) {
  return template
    .replace('{{TITLE}}', title)
    .replace('{{CONTENT}}', content);
}

export function parseModelJson(rawPayload) {
  if (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)) {
    return rawPayload;
  }

  if (typeof rawPayload !== 'string') {
    throw new Error(`Model payload must be object or string, got ${typeof rawPayload}`);
  }

  const direct = rawPayload.trim();
  if (!direct) {
    throw new Error('Model payload is empty');
  }

  try {
    return JSON.parse(direct);
  } catch {
    const extracted = extractFirstJsonObject(direct);
    if (!extracted) {
      throw new Error('Could not find a JSON object in model payload');
    }
    return JSON.parse(extracted);
  }
}

export function sanitizeExtraction(parsed, fallbackSummarySource) {
  const warnings = [];
  const fallbackSummary = summarizeText(fallbackSummarySource);

  let summary = '';
  if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
    summary = cleanText(parsed.summary);
  }
  if (!summary) {
    summary = fallbackSummary;
    warnings.push('Missing summary from model output; used fallback summary.');
  }

  const rawEntities = Array.isArray(parsed?.entities) ? parsed.entities : [];
  if (!Array.isArray(parsed?.entities)) {
    warnings.push('Missing entities array from model output; used empty array.');
  }

  const deduped = new Map();
  for (const rawEntity of rawEntities) {
    if (!rawEntity || typeof rawEntity !== 'object') {
      warnings.push('Skipped non-object entity item.');
      continue;
    }

    const entity = sanitizeEntity(rawEntity);
    if (!entity) {
      warnings.push('Skipped invalid entity item.');
      continue;
    }

    const key = `${entity.type}::${entity.name.toLowerCase()}`;
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, entity);
      continue;
    }

    existing.confidence = Math.max(existing.confidence, entity.confidence);
    existing.aliases = dedupeStrings([...existing.aliases, ...entity.aliases]);
    existing.evidence = dedupeStrings([...existing.evidence, ...entity.evidence]).slice(0, 3);
  }

  const entities = Array.from(deduped.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (a.type !== b.type) return a.type.localeCompare(b.type);
    return a.name.localeCompare(b.name);
  });

  return {
    extraction: { summary, entities },
    warnings,
  };
}

export function summarizeText(content) {
  const cleaned = cleanText(content);
  if (!cleaned) return 'No summary available.';

  const sentenceParts = cleaned
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(Boolean);

  const joined = sentenceParts.slice(0, 2).join(' ');
  if (joined) {
    return truncate(joined, 380);
  }

  return truncate(cleaned, 380);
}

function sanitizeEntity(rawEntity) {
  const rawType = typeof rawEntity.type === 'string' ? rawEntity.type.toLowerCase().trim() : '';
  if (!ENTITY_TYPE_SET.has(rawType)) return null;

  const name = cleanText(rawEntity.name);
  if (!name) return null;

  const aliases = Array.isArray(rawEntity.aliases)
    ? dedupeStrings(rawEntity.aliases.map(cleanText).filter(Boolean).filter(alias => !sameText(alias, name))).slice(0, 12)
    : [];

  const confidenceValue = Number(rawEntity.confidence);
  const confidence = Number.isFinite(confidenceValue) ? clamp01(confidenceValue) : 0.65;

  const evidence = Array.isArray(rawEntity.evidence)
    ? dedupeStrings(rawEntity.evidence.map(cleanText).filter(Boolean)).slice(0, 3)
    : [];

  return {
    type: rawType,
    name,
    aliases,
    confidence,
    evidence,
  };
}

function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim();
}

function sameText(a, b) {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function truncate(value, maxLen) {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1).trim()}…`;
}

function extractFirstJsonObject(text) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaping = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (start === -1) {
      if (ch === '{') {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (ch === '\\') {
        escaping = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}
