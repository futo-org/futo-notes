/**
 * Answer comparison helpers and the coverage guard.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { FIXTURES_OUTSIDE_THE_DIFFERENTIAL } from './known-gaps.mjs';
import { HERE } from './paths.mjs';
import { isAscii } from './seeded-random-and-charsets.mjs';
import { TS_OPS } from './ts-ops.mjs';
import path from 'node:path';

// --- Comparison -------------------------------------------------------------

/**
 * JSON, with every character outside printable ASCII escaped. `JSON.stringify`
 * alone leaves U+0085, U+00A0, U+200B, and U+FEFF as invisible bytes in the
 * failure report - and those are exactly the inputs this differential exists to
 * catch, so an unreadable report is a useless one.
 */
export function describe(value) {
  return JSON.stringify(value).replace(/[^ -~]/gu, (char) =>
    char.codePointAt(0) > 0xffff
      ? `\\u{${char.codePointAt(0).toString(16)}}`
      : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Structural JSON equality via canonical (key-sorted) serialization. */
export function canon(value) {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Drop fields whose *representation* legitimately differs between the two
 * languages. `extractHeaderTagBlock`'s `endOffset` is a UTF-8 byte offset in Rust
 * and a UTF-16 code-unit offset in TypeScript: each is correct for its own string
 * type, and they only coincide for ASCII. The representation-independent
 * `remainder` is compared for EVERY input, so the block boundary itself stays
 * fully locked.
 */
export function comparable(op, input, answer) {
  if (op === 'extractHeaderTagBlock' && !isAscii(input)) {
    const { endOffset: _byteVersusUtf16, ...rest } = answer;
    return rest;
  }
  return answer;
}

// --- Coverage guard ---------------------------------------------------------

export function assertEveryFixtureOpIsCovered(probedOps) {
  const problems = [];
  const files = readdirSync(HERE)
    .filter((name) => name.endsWith('.json'))
    .sort();

  const fixtureOps = new Map(); // op -> the fixture file that exercises it
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(path.join(HERE, file), 'utf8'));
    if (!Array.isArray(fixture.groups)) {
      if (!(file in FIXTURES_OUTSIDE_THE_DIFFERENTIAL)) {
        problems.push(
          `${file} is a conformance corpus this differential neither drives nor ` +
            'excludes. Either give its ops a family in FAMILIES, or add it to ' +
            'FIXTURES_OUTSIDE_THE_DIFFERENTIAL with the reason it cannot be driven.',
        );
      }
      continue;
    }
    for (const group of fixture.groups) fixtureOps.set(group.op, file);
  }

  for (const [op, file] of fixtureOps) {
    if (probedOps.has(op)) continue;
    problems.push(
      `op "${op}" is exercised by ${file} but never probed by this differential - the ` +
        'hand-reviewed goldens would be the only thing holding the two languages ' +
        'together. Add it to the owning family in FAMILIES.',
    );
  }
  for (const op of probedOps) {
    if (!(op in TS_OPS)) problems.push(`op "${op}" is probed but has no TS_OPS entry.`);
  }

  if (problems.length > 0) {
    process.stderr.write(
      `Rule-differential coverage guard failed:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`,
    );
    process.exit(1);
  }
}
