import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const workspaceManifest = load(readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8'));

describe('package safety policy', () => {
  it('retains the approved install scripts and security overrides', () => {
    expect(workspaceManifest.onlyBuiltDependencies).toEqual(['esbuild', 'protobufjs']);
    expect(workspaceManifest.overrides).toEqual({
      'devalue@<5.8.1': '5.8.1',
      'picomatch@4': '4.0.4',
      'esbuild@<0.28.1': '0.28.1',
    });
  });

  it('pins the shared Lezer runtime used by CodeMirror', () => {
    expect(packageManifest.dependencies['@lezer/common']).toBe('1.5.1');
  });
});
