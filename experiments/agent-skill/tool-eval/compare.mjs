// Side by side, per task: node compare.mjs <labelA> <labelB>
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
// Rescored here with run.mjs's current normaliser, so runs made before a normaliser change compare fairly.
const normalize = (text) =>
  (text ?? '')
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .replace(/,\s+/g, ',')
    .trim();
const load = (label) =>
  Object.fromEntries(
    readdirSync(join(here, 'runs', label))
      .filter((f) => f.endsWith('.json') && f !== 'summary.json')
      .map((f) => {
        const r = JSON.parse(readFileSync(join(here, 'runs', label, f), 'utf8'));
        // A workflow task carries a verifier verdict (null = passed); a response task is rescored here.
        if ('verdict' in r && r.expected == null) {
          r.score = Number(r.verdict === null);
          r.lenient = r.score;
        } else {
          r.score = Number(normalize(r.actual) === normalize(r.expected));
          r.lenient = Number(normalize(r.actual).includes(normalize(r.expected)));
        }
        return [r.id, r];
      }),
  );
const [a, b] = process.argv.slice(2);
const A = load(a),
  B = load(b);
// Task ids come from the runs themselves, so a workflow run and a tasks.json run each compare against their own set.
const tasks = [...new Set([...Object.keys(A), ...Object.keys(B)])];
const sum = (R, key) =>
  tasks.reduce(
    (s, id) => s + (typeof R[id]?.[key] === 'number' ? R[id][key] : (R[id]?.[key]?.length ?? 0)),
    0,
  );
console.log(`| task | ${a} ok/calls/s | ${b} ok/calls/s | Δcalls |\n|---|---|---|---|`);
for (const id of tasks) {
  const x = A[id],
    y = B[id];
  const cell = (r) =>
    r ? `${r.score ? '✓' : r.lenient ? '~' : '✗'} ${r.calls.length} ${r.seconds}` : '—';
  console.log(
    `| ${id} | ${cell(x)} | ${cell(y)} | ${x && y ? y.calls.length - x.calls.length : ''} |`,
  );
}
for (const [label, R] of [
  [a, A],
  [b, B],
])
  console.log(
    `\n${label}: strict ${sum(R, 'score')}/${tasks.length} · lenient ${sum(R, 'lenient')} · calls ${sum(R, 'calls')} · ${sum(R, 'seconds').toFixed(0)}s · $${sum(R, 'costUsd').toFixed(2)}`,
  );
