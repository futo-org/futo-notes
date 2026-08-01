// Shared by the gate-redproofs self-test fixtures: is the harness's seeded
// violation present? Resolved against this file's own directory so the fixture
// gates behave identically however they are launched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function sentinelExists() {
  return fs.existsSync(path.join(HERE, 'seeded-violation'));
}
