/**
 * Vector math and text scoring utilities for hybrid search.
 */

/**
 * Compute dot product of two vectors.
 */
export function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}

/**
 * Compute the magnitude (L2 norm) of a vector.
 */
export function magnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i] * v[i];
  }
  return Math.sqrt(sum);
}

/**
 * Normalize a vector to unit length.
 */
export function normalize(v: number[]): number[] {
  const mag = magnitude(v);
  if (mag === 0) return v;
  return v.map((x) => x / mag);
}

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 means identical direction.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

/**
 * Tokenize text into lowercase words for keyword matching.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/**
 * Compute keyword match score between query and text.
 * Returns a value between 0 and 1 based on what fraction of query words appear in the text.
 * Exact matches are weighted more heavily.
 */
export function keywordScore(query: string, text: string): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const textLower = text.toLowerCase();
  const textTokens = new Set(tokenize(text));

  let score = 0;

  for (const queryWord of queryTokens) {
    // Exact word match (word boundary)
    if (textTokens.has(queryWord)) {
      score += 1.0;
    }
    // Partial/substring match (less weight)
    else if (textLower.includes(queryWord)) {
      score += 0.5;
    }
  }

  // Normalize by number of query words
  return score / queryTokens.length;
}
