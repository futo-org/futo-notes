#!/usr/bin/env node
// What Claude drove itself in the gate runs (`drive` did not cover it): each verb it ran by hand,
// with what it was for, so the coverage gaps can be read off the data rather than guessed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('runs-diagnose/', import.meta.url).pathname;
const verbs = {};
for (const bug of readdirSync(root)) {
  for (const run of readdirSync(join(root, bug)).filter((name) => name.startsWith('gate'))) {
    const file = join(root, bug, run, 'transcript.jsonl');
    if (!existsSync(file)) continue;
    const events = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    for (const event of events.filter((e) => e.type === 'assistant'))
      for (const block of event.message.content.filter((b) => b.type === 'tool_use')) {
        const command = block.input.command ?? '';
        for (const match of command.matchAll(/just puppet do\s+'?(\[\[)?"?([A-Z]\w+)/g)) {
          const key = `${match[2]}${match[1] ? ' (batch)' : ''}`;
          (verbs[key] ??= new Set()).add(bug.slice(0, 2));
        }
        for (const match of command.matchAll(/just puppet (click|tap|drag)\s+'([^']*)'/g)) {
          const key = `${match[1]} ${/"ref"/.test(match[2]) ? 'by ref' : 'at x,y'}`;
          (verbs[key] ??= new Set()).add(bug.slice(0, 2));
        }
      }
  }
}
for (const [verb, bugs] of Object.entries(verbs).sort())
  console.log(`${verb.padEnd(28)} bugs ${[...bugs].sort().join(',')}`);
