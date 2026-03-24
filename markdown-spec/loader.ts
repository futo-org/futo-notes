import { readFileSync, readdirSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import type { SpecCase } from './schema.js';

export function loadSpecCases(dir: string, maxComplexity?: number): SpecCase[] {
  const files = readdirSync(dir, { recursive: true }) as string[];
  const cases: SpecCase[] = [];

  for (const file of files) {
    const ext = extname(file);
    if (ext === '.yaml' || ext === '.yml') {
      cases.push(...loadSpecFile(join(dir, file)));
    }
  }

  cases.sort((a, b) => a.complexity - b.complexity);
  return maxComplexity !== undefined ? cases.filter(c => c.complexity <= maxComplexity) : cases;
}

export function loadSpecFile(filePath: string): SpecCase[] {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = yaml.load(content);

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array in ${filePath}, got ${typeof parsed}`);
  }

  // Strip trailing newlines from YAML block scalars
  for (const c of parsed as SpecCase[]) {
    if (c.markdown.endsWith('\n')) {
      c.markdown = c.markdown.replace(/\n$/, '');
    }
  }

  return parsed as SpecCase[];
}

export function getCasesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'cases');
}
