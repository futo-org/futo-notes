#!/usr/bin/env node

/**
 * End-to-end tag pipeline:
 *   1. tag-discover  — free-form tag discovery per note
 *   2. tag-consolidate — merge, prune, build taxonomy
 *   3. tag-assign    — assign from fixed taxonomy per note
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const passthrough = process.argv.slice(2);

// Extract --notes-dir for scripts that need it
const notesDirIdx = passthrough.indexOf('--notes-dir');
const notesDir = notesDirIdx >= 0 ? passthrough[notesDirIdx + 1] : '';

// Extract flags that apply to all phases
const globalFlags = [];
for (let i = 0; i < passthrough.length; i++) {
  const arg = passthrough[i];
  if (['--model', '--ollama-host', '--vllm-host', '--max-notes', '--max-note-chars', '--concurrency'].includes(arg)) {
    globalFlags.push(arg, passthrough[i + 1] ?? '');
    i++;
  }
  if (['--force', '--mock', '--think', '--vllm'].includes(arg)) {
    globalFlags.push(arg);
  }
}

// Split --think out of globalFlags — only discovery gets it
const flagsWithoutThink = globalFlags.filter(f => f !== '--think');

const steps = [
  {
    label: 'tag-discover',
    script: path.join(__dirname, 'tag-discover.mjs'),
    args: ['--notes-dir', notesDir, ...globalFlags],
  },
  {
    label: 'tag-consolidate',
    script: path.join(__dirname, 'tag-consolidate.mjs'),
    args: [],
  },
  {
    label: 'tag-assign',
    script: path.join(__dirname, 'tag-assign.mjs'),
    args: ['--notes-dir', notesDir, ...flagsWithoutThink],
  },
];

for (const step of steps) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[tag-pipeline] Phase: ${step.label}`);
  console.log(`${'='.repeat(60)}\n`);

  const code = await runStep(step.script, step.args);
  if (code !== 0 && code !== 2) {
    console.error(`[tag-pipeline] ${step.label} exited with code ${code}`);
    process.exit(1);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log('[tag-pipeline] All phases complete.');
console.log(`${'='.repeat(60)}`);

function runStep(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
    child.on('error', reject);
    child.on('close', code => resolve(code ?? 1));
  });
}
