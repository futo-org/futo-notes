#!/usr/bin/env node
// Where a diagnosis run's time went: for every tool call, the model's time deciding it (since the
// previous result) plus the tool's own run time, bucketed as app driving (`drive` / single verbs),
// reading code, or other. The final answer's writing time is its own bucket.
//
//   node time-split.mjs            every run under runs-diagnose/, one row each
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'runs-diagnose');

function bucket(block) {
  const command = block.input?.command ?? '';
  if (/(just puppet|futo-puppet)\b/.test(command))
    return /\bdrive\b/.test(command) ? 'drive' : 'verbs';
  if (
    ['Read', 'Grep', 'Glob'].includes(block.name) ||
    /^\s*(rg|grep|cat|sed|head|tail|find|wc|ls)\b/.test(command)
  )
    return 'code';
  return 'other';
}

function split(file) {
  const events = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const at = (event) => Date.parse(event.timestamp);
  const stamped = events.filter((event) => event.timestamp);
  if (!stamped.length) return null;
  const start = at(stamped[0]);
  const calls = new Map(); // tool_use id → { bucket, issued }
  const seconds = {
    drive: 0,
    verbs: 0,
    code: 0,
    other: 0,
    answer: 0,
    appRun: 0,
    appThink: 0,
    appCalls: 0,
  };
  let lastResult = start;
  for (const event of stamped) {
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'assistant') {
      for (const block of blocks.filter((b) => b.type === 'tool_use')) {
        const kind = bucket(block);
        const think = Math.max(0, at(event) - lastResult) / 1000; // deciding it
        seconds[kind] += think;
        if (kind === 'drive' || kind === 'verbs') {
          seconds.appThink += think;
          seconds.appCalls += 1;
        }
        lastResult = at(event); // parallel calls in one turn share one decision
        calls.set(block.id, { kind, issued: at(event) });
      }
    } else if (event.type === 'user') {
      for (const block of blocks.filter((b) => b.type === 'tool_result')) {
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        const ran = Math.max(0, at(event) - call.issued) / 1000; // running it
        seconds[call.kind] += ran;
        if (call.kind === 'drive' || call.kind === 'verbs') seconds.appRun += ran;
        lastResult = Math.max(lastResult, at(event));
      }
    }
  }
  const end = at(stamped[stamped.length - 1]);
  seconds.answer = Math.max(0, end - lastResult) / 1000;
  return { total: (end - start) / 1000, ...seconds };
}

const rows = [];
for (const bug of existsSync(root) ? readdirSync(root).sort() : []) {
  for (const run of readdirSync(join(root, bug)).sort()) {
    const dir = join(root, bug, run);
    if (!existsSync(join(dir, 'score.json'))) continue;
    const parts = split(join(dir, 'transcript.jsonl'));
    if (!parts) continue;
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    const score = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
    const arm = meta.label ?? 'baseline';
    const s = (n) => `${Math.round(n)}s`;
    const driving = parts.drive + parts.verbs;
    rows.push(
      `| ${bug} | ${arm}${meta.say ? ` (${meta.say})` : ''} | ${score.recreated ? '✓' : '✗'} ${score.cause} | ${s(parts.total)} | **${s(driving)}** | ${parts.appCalls} | ${s(parts.appThink)} | ${s(parts.appRun)} | ${parts.appCalls ? (parts.appThink / parts.appCalls).toFixed(1) : '-'}s | ${parts.appCalls ? (parts.appRun / parts.appCalls).toFixed(1) : '-'}s |`,
    );
  }
}
console.log(
  [
    '| bug | arm | result | total | driving | app calls | Claude thinking before them | the calls running | think per call | run per call |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n'),
);
