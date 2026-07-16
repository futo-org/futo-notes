import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function classifyChangedFiles(files) {
  if (files.length === 0) return 'full';

  return files.every((file) => file.endsWith('.md')) ? 'docs' : 'full';
}

function changedFilesFromMergeRequest() {
  if (!process.env.CI_MERGE_REQUEST_IID) return [];

  const base = process.env.CI_MERGE_REQUEST_DIFF_BASE_SHA;
  const head = process.env.CI_COMMIT_SHA ?? 'HEAD';
  if (!base) return [];

  // Deletions matter: deleting source alongside editing docs must stay on the
  // full path, so inspect every changed path rather than filtering by status.
  const result = spawnSync('git', ['diff', '--name-only', base, head], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    return [];
  }

  return result.stdout
    .split('\n')
    .map((file) => file.trim())
    .filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const explicitFiles = process.argv.slice(2);
  const files = explicitFiles.length > 0 ? explicitFiles : changedFilesFromMergeRequest();
  process.stdout.write(`${classifyChangedFiles(files)}\n`);
}
