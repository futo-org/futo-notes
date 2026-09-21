import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const workspaceManifest = load(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));

describe('package safety policy', () => {
  it('grants install scripts only to the approved dependencies', () => {
    expect(workspaceManifest.onlyBuiltDependencies).toEqual(['esbuild', 'protobufjs']);
  });

  it('pins the shared Lezer runtime exactly, so the bundle carries one copy', () => {
    expect(packageManifest.dependencies['@lezer/common']).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
