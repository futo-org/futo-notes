import { getFS, hasFileSystem } from './platform';

export interface PersistedJsonOptions<T> {
  path: string;
  defaultValue: T | (() => T);
  validate?: (raw: unknown) => T | null;  // return null to use default
  cache?: boolean;           // hold loaded value in memory (default false)
  cloneOnRead?: boolean;     // structuredClone cached value on load (default false)
}

export interface PersistedJsonStore<T> {
  load(): Promise<T>;
  save(value: T): Promise<void>;
  invalidate(): void;   // clear in-memory cache (next load re-reads from disk)
  clear(): Promise<void>; // delete the file + invalidate cache
}

function resolveDefault<T>(defaultValue: T | (() => T)): T {
  return typeof defaultValue === 'function' ? (defaultValue as () => T)() : defaultValue;
}

export function persistedJson<T>(options: PersistedJsonOptions<T>): PersistedJsonStore<T> {
  const { path, defaultValue, validate, cache = false, cloneOnRead = false } = options;

  let cached: T | undefined;
  let hasCached = false;

  function getDefault(): T {
    return resolveDefault(defaultValue);
  }

  async function load(): Promise<T> {
    if (cache && hasCached) {
      return cloneOnRead ? structuredClone(cached as T) : (cached as T);
    }

    if (!hasFileSystem) {
      const def = getDefault();
      if (cache) { cached = def; hasCached = true; }
      return cloneOnRead ? structuredClone(def) : def;
    }

    try {
      const content = await getFS().readAppData(path);
      if (!content) {
        const def = getDefault();
        if (cache) { cached = def; hasCached = true; }
        return cloneOnRead ? structuredClone(def) : def;
      }

      let parsed: unknown = JSON.parse(content);

      if (validate) {
        const validated = validate(parsed);
        if (validated === null) {
          const def = getDefault();
          if (cache) { cached = def; hasCached = true; }
          return cloneOnRead ? structuredClone(def) : def;
        }
        parsed = validated;
      }

      const value = parsed as T;
      if (cache) { cached = value; hasCached = true; }
      return cloneOnRead ? structuredClone(value) : value;
    } catch {
      const def = getDefault();
      if (cache) { cached = def; hasCached = true; }
      return cloneOnRead ? structuredClone(def) : def;
    }
  }

  async function save(value: T): Promise<void> {
    if (cache) { cached = value; hasCached = true; }
    if (!hasFileSystem) return;
    await getFS().writeAppData(path, JSON.stringify(value, null, 2));
  }

  function invalidate(): void {
    cached = undefined;
    hasCached = false;
  }

  async function clear(): Promise<void> {
    invalidate();
    if (!hasFileSystem) return;
    await getFS().deleteAppData(path);
  }

  return { load, save, invalidate, clear };
}
