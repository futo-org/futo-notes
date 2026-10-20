/**
 * Where the conformance fixtures and the repo root are.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

// The conformance directory: this module lives one level below it.
export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(HERE, '../..');
