#!/usr/bin/env node
// After each `just puppet do …` Claude ran, did it read the app again before its next action, and
// did the `do` receipt carry a diff? Separates "the diff was missing or wrong" from "the diff was
// there and Claude read anyway", and counts reads chained into the same command as the action.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('runs-diagnose/', import.meta.url).pathname;
const READ = /just puppet (state|doc|elements|events|at|show|notes)\b/;
const tally = {
  dos: 0,
  withDiff: 0,
  noDiff: 0,
  chainedRead: 0,
  readNextWithDiff: 0,
  readNextNoDiff: 0,
  whatRead: {},
};
for (const bug of readdirSync(root)) {
  for (const run of readdirSync(join(root, bug))) {
    const file = join(root, bug, run, 'transcript.jsonl');
    if (!existsSync(file)) continue;
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const results = new Map();
    for (const e of events.filter((x) => x.type === 'user'))
      for (const b of Array.isArray(e.message.content) ? e.message.content : [])
        if (b.type === 'tool_result')
          results.set(
            b.tool_use_id,
            Array.isArray(b.content)
              ? b.content.map((c) => c.text ?? '').join('')
              : String(b.content ?? ''),
          );
    const calls = events
      .filter((e) => e.type === 'assistant')
      .flatMap((e) => e.message.content.filter((b) => b.type === 'tool_use'))
      .map((b) => ({ command: b.input.command ?? '', result: results.get(b.id) ?? '' }))
      .filter((c) => /just puppet|futo-puppet/.test(c.command));
    calls.forEach((call, i) => {
      if (
        !/just puppet do\b/.test(call.command) ||
        /acting on the app goes through Jev/.test(call.result)
      )
        return;
      tally.dos += 1;
      const hasDiff = /"diff"/.test(call.result);
      hasDiff ? (tally.withDiff += 1) : (tally.noDiff += 1);
      if (READ.test(call.command)) {
        tally.chainedRead += 1;
        const what = call.command.match(READ)[1];
        tally.whatRead[what] = (tally.whatRead[what] ?? 0) + 1;
      }
      const next = calls[i + 1];
      if (next && READ.test(next.command) && !/just puppet do\b/.test(next.command)) {
        hasDiff ? (tally.readNextWithDiff += 1) : (tally.readNextNoDiff += 1);
        const what = next.command.match(READ)[1];
        tally.whatRead[what] = (tally.whatRead[what] ?? 0) + 1;
      }
    });
  }
}
console.log(JSON.stringify(tally, null, 2));
