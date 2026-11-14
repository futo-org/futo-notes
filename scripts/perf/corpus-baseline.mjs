#!/usr/bin/env node
// Analyze a pinned public notes corpus and export whole-note, targeted fixtures.
// No device changes. Outputs source hashes/percentiles separately from latency.
import console from 'node:console';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import process from 'node:process';
import { describe, summarize, select } from './corpus-baseline/model.mjs';
const args = process.argv.slice(2);
function arg(key, fallback) {
  const i = args.indexOf(key);
  return i < 0 ? fallback : args[i + 1];
}
const file = arg('--corpus', process.env.FUTO_NOTES_CORPUS);
if (!file) throw new Error('Set FUTO_NOTES_CORPUS or --corpus <notes_corpus.jsonl.gz>');
const out = path.resolve(arg('--out', '.futo/corpus-baseline/fixtures'));
const packed = readFileSync(file);
const inputNotes = gunzipSync(packed)
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((s) => JSON.parse(s));
const sourceTypes = arg('--source-types', null)?.split(',');
const notes = sourceTypes
  ? inputNotes.filter((n) => sourceTypes.includes(n.source_type))
  : inputNotes;
if (!notes.length) throw new Error('No corpus notes matched source types');
const hashes = new Set();
for (const n of notes) {
  if (typeof n.body !== 'string' || !n.content_hash || hashes.has(n.content_hash))
    throw new Error('Invalid/duplicate corpus record');
  hashes.add(n.content_hash);
}
const records = notes.map(describe);
const report = {
  formatVersion: 1,
  corpusSha256: createHash('sha256').update(packed).digest('hex'),
  corpusRevision: arg('--revision', null),
  notes: records.length,
  inputNotes: inputNotes.length,
  sourceTypes: sourceTypes ?? null,
  sourceCount: new Set(notes.map((n) => `${n.source_type}:${n.source_id}`)).size,
  method:
    'Nearest-rank per-note maxima, conditional on feature present; UTF-16 source length for paragraphs; nested items per outer list; header included in table cells. Lezer CommonMark+GFM, not canonical engine semantics. Public corpus, not usage telemetry.',
  metrics: summarize(records),
  sources: {},
};
for (const r of records) report.sources[r.sourceType] = (report.sources[r.sourceType] ?? 0) + 1;
report.bySourceType = Object.fromEntries(
  Object.keys(report.sources).map((type) => [
    type,
    summarize(records.filter((r) => r.sourceType === type)),
  ]),
);
const picks = select(records, notes, Number(arg('--per-quantile', '3')));
mkdirSync(out, { recursive: true });
const manifest = picks.map(({ body, ...meta }, i) => {
  const file = `n${String(i).padStart(3, '0')}.md`;
  writeFileSync(path.join(out, file), body);
  return { file, ...meta };
});
writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
writeFileSync(path.join(out, 'analysis.json'), JSON.stringify(report, null, 2));
writeFileSync(path.join(out, 'descriptors.json'), JSON.stringify(records));
console.log(JSON.stringify(report, null, 2));
console.log(`Fixtures: ${out} (${picks.length}, including separate p100 stress cases)`);
