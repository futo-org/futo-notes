#!/usr/bin/env node

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const passthroughArgs = process.argv.slice(2);

const steps = [
  {
    script: 'run-extraction.mjs',
    valueFlags: new Set(['--notes-dir', '--cache-file', '--output-dir', '--prompt-file', '--schema-file', '--model', '--ollama-host', '--max-notes', '--max-note-chars']),
    booleanFlags: new Set(['--force', '--mock', '--help', '-h']),
  },
  {
    script: 'normalize-entities.mjs',
    valueFlags: new Set(['--notes-dir', '--cache-file', '--output', '--fuzzy-threshold', '--low-confidence-threshold']),
    booleanFlags: new Set(['--help', '-h']),
  },
  {
    script: 'build-reports.mjs',
    valueFlags: new Set(['--input', '--output-dir']),
    booleanFlags: new Set(['--help', '-h']),
  },
  {
    script: 'review-queue.mjs',
    valueFlags: new Set(['--input', '--output']),
    booleanFlags: new Set(['--help', '-h']),
  },
];

for (const step of steps) {
  const scriptPath = path.join(__dirname, step.script);
  const stepArgs = filterArgs(passthroughArgs, step.valueFlags, step.booleanFlags);
  await runStep(scriptPath, stepArgs);
}

console.log('[entity-lab] end-to-end pipeline complete.');

function runStep(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Step failed (${path.basename(scriptPath)}) with exit code ${code ?? 'unknown'}`));
    });
  });
}

function filterArgs(argv, valueFlags, booleanFlags) {
  const filtered = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (booleanFlags.has(arg)) {
      filtered.push(arg);
      continue;
    }

    if (valueFlags.has(arg)) {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`Missing value for ${arg}`);
      }
      filtered.push(arg, next);
      i += 1;
      continue;
    }
  }

  return filtered;
}
