import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const justfile = readFileSync(join(ROOT, 'justfile'), 'utf8');
const gitlabPipeline = readFileSync(join(ROOT, '.gitlab-ci.yml'), 'utf8');
const packageScripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;

function topLevelBlock(contents, startPattern) {
  const match = startPattern.exec(contents);
  if (match?.index == null) throw new Error(`Missing operational entry point: ${startPattern}`);

  const blockStart = match.index;
  const remainingContents = contents.slice(blockStart + match[0].length);
  const nextBlockOffset = remainingContents.search(/^\S[^\n]*:\s*(?:#.*)?$/m);

  return nextBlockOffset === -1
    ? contents.slice(blockStart)
    : contents.slice(blockStart, blockStart + match[0].length + nextBlockOffset);
}

describe('pre-merge JavaScript test parity', () => {
  it('runs the full suite from just check', () => {
    const checkRecipe = topLevelBlock(justfile, /^check:[^\n]*$/m);

    expect(checkRecipe).toContain('pnpm run test:full');
    expect(checkRecipe).not.toContain('pnpm run test:minimal');
  });

  it('runs the full suite from pnpm ci', () => {
    expect(packageScripts.ci).toContain('pnpm run test:full');
    expect(packageScripts.ci).not.toContain('pnpm run test:minimal');
  });

  it('runs the full suite from the GitLab test job', () => {
    const testJob = topLevelBlock(gitlabPipeline, /^test:$/m);

    expect(testJob).toContain('pnpm run test:full');
    expect(testJob).not.toContain('pnpm run test:minimal');
  });
});
