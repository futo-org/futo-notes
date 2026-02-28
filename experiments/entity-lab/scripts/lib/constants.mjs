import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const LAB_ROOT = path.resolve(__dirname, '..', '..');
export const PROMPTS_DIR = path.join(LAB_ROOT, 'prompts');
export const SCHEMAS_DIR = path.join(LAB_ROOT, 'schemas');
export const CACHE_DIR = path.join(LAB_ROOT, 'cache');
export const RUNS_DIR = path.join(LAB_ROOT, 'runs');
export const REPORTS_DIR = path.join(LAB_ROOT, 'reports');

export const DEFAULT_MODEL = 'qwen3:8b';
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export const CACHE_VERSION = 1;
export const PROMPT_VERSION = 'entity-v1-2026-02-28';
export const SCHEMA_VERSION = 1;

export const ENTITY_TYPES = ['project', 'person', 'organization', 'tool', 'place'];

export function makeTimestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
