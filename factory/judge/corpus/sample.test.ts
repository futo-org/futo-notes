import { gzipSync } from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sampleCorpusScenarios } from './sample.ts';

function writeCorpus(records: unknown[], gzipped = false): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'futo-corpus-sample-'));
  const file = path.join(directory, gzipped ? 'sample.jsonl.gz' : 'sample.jsonl');
  const contents = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  writeFileSync(file, gzipped ? gzipSync(contents) : contents);
  return file;
}

describe('sampleCorpusScenarios', () => {
  it('stratifies deterministically without propagating source metadata', async () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      content_hash: `secret-hash-${index}`,
      title: `secret title ${index}`,
      source_url: `https://example.test/${index}`,
      body:
        index % 4 === 0
          ? `> [!note] callout ${index}\nbody`
          : index % 4 === 1
            ? `| a | b |\n| --- | --- |\n| ${index} | x |`
            : index % 4 === 2
              ? `# heading ${index}\nbody`
              : `plain body ${index}`,
    }));
    const corpus = writeCorpus(records, true);

    const first = await sampleCorpusScenarios(corpus, { size: 12, seed: 41 });
    const second = await sampleCorpusScenarios(corpus, { size: 12, seed: 41 });

    expect(second).toEqual(first);
    expect(first.scenarios).toHaveLength(12);
    expect(new Set(first.scenarios.map((scenario) => scenario.construct))).toEqual(
      new Set(['callout', 'table', 'heading', 'plain']),
    );
    expect(JSON.stringify(first)).not.toContain('secret-hash');
    expect(JSON.stringify(first)).not.toContain('secret title');
    expect(JSON.stringify(first)).not.toContain('example.test');
  });

  it('skips PII-flagged, unusable, and oversized records without truncating constructs', async () => {
    const completeFrontmatter = `---\ntitle: ${'x'.repeat(30)}\n---\n# kept intact`;
    const corpus = writeCorpus([
      { body: '# do not sample', pii_flag: 1 },
      { title: 'missing body' },
      { body: `---\ntitle: oversized\n---\n\n\`\`\`js\n${'x'.repeat(200)}\n\`\`\`` },
      { body: completeFrontmatter },
    ]);

    const result = await sampleCorpusScenarios(corpus, {
      size: 10,
      seed: 7,
      maxBodyLines: 20,
      maxBodyChars: 80,
    });

    expect(result.stats).toMatchObject({
      recordsSeen: 4,
      usableNotes: 1,
      missingBodies: 1,
      piiFlaggedSkipped: 1,
      oversizedNotesSkipped: 1,
    });
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].markdown).toBe(completeFrontmatter);
  });

  it('keeps a complete long fenced construct when it is within the explicit bound', async () => {
    const fenced = `before\n\n\`\`\`ts\n${Array.from({ length: 30 }, (_, i) => `const n${i} = ${i};`).join('\n')}\n\`\`\`\n\nafter`;
    const corpus = writeCorpus([{ body: fenced }]);

    const result = await sampleCorpusScenarios(corpus, {
      size: 1,
      seed: 9,
      maxBodyLines: 40,
      maxBodyChars: 1_000,
    });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].markdown).toBe(fenced);
    expect(result.scenarios[0].markdown).toMatch(/```ts[\s\S]*```/);
  });
});
