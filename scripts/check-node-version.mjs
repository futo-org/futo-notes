#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expected = fs.readFileSync(path.join(root, '.nvmrc'), 'utf8').trim();
const actual = process.versions.node;
if (actual !== expected) {
  console.error(`Node ${actual} is active; this repository requires ${expected} from .nvmrc.`);
  console.error('  Run: just setup');
  process.exit(1);
}
