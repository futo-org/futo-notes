import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (isNotFound(err)) return fallback;
    throw err;
  }
}

export async function writeJsonFile(filePath, value) {
  const raw = JSON.stringify(value, null, 2);
  await fs.writeFile(filePath, raw + '\n', 'utf8');
}

export async function appendJsonLine(filePath, value) {
  const raw = JSON.stringify(value);
  await fs.appendFile(filePath, raw + '\n', 'utf8');
}

export async function listMarkdownFiles(rootDir) {
  const results = [];

  async function walk(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      results.push(absPath);
    }
  }

  await walk(rootDir);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

export function toPosixPath(input) {
  return input.split(path.sep).join('/');
}

export function getNoteTitleFromPath(notePath) {
  const filename = path.basename(notePath);
  return filename.replace(/\.md$/i, '');
}

function isNotFound(err) {
  return err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT';
}
