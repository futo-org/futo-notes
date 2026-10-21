// Cirrus has no YAML include: .cirrus.star appends the task files it lists to
// .cirrus.yml before the config is parsed. Text checks read the same files in
// the same order through here. Paths are relative to `root`.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const CIRRUS_YML = '.cirrus.yml';
export const CIRRUS_STAR = '.cirrus.star';

export function cirrusCiPaths(root) {
  const star = readFileSync(path.join(root, CIRRUS_STAR), 'utf8');
  const list = star.match(/^TASK_FILES = \[\n([\s\S]*?)^\]/m);
  if (!list) throw new Error(`${CIRRUS_STAR} has no TASK_FILES list`);
  const files = [...list[1].matchAll(/^ {4}"([^"]+)",$/gm)].map((match) => match[1]);
  return [CIRRUS_YML, ...files];
}

// The whole Cirrus config as one text, the way the Cirrus CLI joins it.
export function readCirrusCiSource(root) {
  return cirrusCiPaths(root)
    .map((file) => readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
}
