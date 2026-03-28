import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// Use the manual mock for tests that need a real FS
vi.mock('$lib/platform');

import { testFS } from '$lib/platform';
import { persistedJson } from './persistedJson';

const TEST_PATH = '.persisted-test.json';

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

describe('persistedJson', () => {
  describe('load', () => {
    it('returns default when no file exists', async () => {
      const store = persistedJson<string[]>({ path: TEST_PATH, defaultValue: [] });
      const value = await store.load();
      expect(value).toEqual([]);
    });

    it('returns default from factory function', async () => {
      const factory = vi.fn(() => ({ count: 0 }));
      const store = persistedJson({ path: TEST_PATH, defaultValue: factory });
      const value = await store.load();
      expect(value).toEqual({ count: 0 });
      expect(factory).toHaveBeenCalledOnce();
    });

    it('calls factory each time for fresh defaults', async () => {
      let callCount = 0;
      const store = persistedJson({
        path: TEST_PATH,
        defaultValue: () => ({ id: ++callCount }),
      });
      const v1 = await store.load();
      const v2 = await store.load();
      expect(v1.id).toBe(1);
      expect(v2.id).toBe(2);
    });

    it('returns parsed value from valid JSON', async () => {
      const data = { name: 'test', items: [1, 2, 3] };
      await testFS.writeAppData(TEST_PATH, JSON.stringify(data));
      const store = persistedJson<typeof data>({ path: TEST_PATH, defaultValue: { name: '', items: [] } });
      const value = await store.load();
      expect(value).toEqual(data);
    });

    it('returns default on invalid JSON', async () => {
      await testFS.writeAppData(TEST_PATH, '{broken json!!!');
      const store = persistedJson<string[]>({ path: TEST_PATH, defaultValue: ['fallback'] });
      const value = await store.load();
      expect(value).toEqual(['fallback']);
    });

    it('returns default when validate returns null', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ bad: true }));
      const store = persistedJson<{ good: boolean }>({
        path: TEST_PATH,
        defaultValue: { good: true },
        validate: () => null,
      });
      const value = await store.load();
      expect(value).toEqual({ good: true });
    });

    it('returns validated value when validate returns non-null', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ x: 1, extra: 'junk' }));
      const store = persistedJson<{ x: number }>({
        path: TEST_PATH,
        defaultValue: { x: 0 },
        validate: (raw) => {
          if (raw && typeof raw === 'object' && 'x' in raw && typeof (raw as Record<string, unknown>).x === 'number') {
            return { x: (raw as Record<string, unknown>).x as number };
          }
          return null;
        },
      });
      const value = await store.load();
      expect(value).toEqual({ x: 1 });
    });
  });

  describe('save + load roundtrip', () => {
    it('persists and reads back', async () => {
      const store = persistedJson<{ items: string[] }>({ path: TEST_PATH, defaultValue: { items: [] } });
      await store.save({ items: ['a', 'b'] });
      const value = await store.load();
      expect(value).toEqual({ items: ['a', 'b'] });
    });

    it('writes pretty JSON to disk', async () => {
      const store = persistedJson<number[]>({ path: TEST_PATH, defaultValue: [] });
      await store.save([1, 2, 3]);
      const raw = await testFS.readAppData(TEST_PATH);
      expect(raw).toBe(JSON.stringify([1, 2, 3], null, 2));
    });
  });

  describe('cache behavior', () => {
    it('second load returns cached without re-reading', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ v: 1 }));
      const store = persistedJson<{ v: number }>({ path: TEST_PATH, defaultValue: { v: 0 }, cache: true });

      const v1 = await store.load();
      expect(v1).toEqual({ v: 1 });

      // Write different data to disk — cached store should not see it
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ v: 999 }));
      const v2 = await store.load();
      expect(v2).toEqual({ v: 1 });
    });

    it('save updates cache', async () => {
      const store = persistedJson<{ v: number }>({ path: TEST_PATH, defaultValue: { v: 0 }, cache: true });
      await store.load(); // cache default
      await store.save({ v: 42 });

      // Write different data to disk — cache should still return saved value
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ v: 999 }));
      const value = await store.load();
      expect(value).toEqual({ v: 42 });
    });
  });

  describe('cloneOnRead', () => {
    it('mutations do not affect cached value', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ items: ['original'] }));
      const store = persistedJson<{ items: string[] }>({
        path: TEST_PATH,
        defaultValue: { items: [] },
        cache: true,
        cloneOnRead: true,
      });

      const v1 = await store.load();
      v1.items.push('mutated');

      const v2 = await store.load();
      expect(v2.items).toEqual(['original']);
    });
  });

  describe('invalidate', () => {
    it('clears cache so next load re-reads from disk', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ v: 1 }));
      const store = persistedJson<{ v: number }>({ path: TEST_PATH, defaultValue: { v: 0 }, cache: true });

      await store.load(); // cache { v: 1 }
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ v: 2 }));

      // Still cached
      expect(await store.load()).toEqual({ v: 1 });

      // After invalidate, re-reads
      store.invalidate();
      expect(await store.load()).toEqual({ v: 2 });
    });
  });

  describe('clear', () => {
    it('deletes file and invalidates cache', async () => {
      await testFS.writeAppData(TEST_PATH, JSON.stringify({ data: true }));
      const store = persistedJson<{ data: boolean } | null>({
        path: TEST_PATH,
        defaultValue: null,
        cache: true,
      });

      await store.load(); // cache { data: true }
      await store.clear();

      // File should be gone
      const raw = await testFS.readAppData(TEST_PATH);
      expect(raw).toBeNull();

      // Load returns default
      const value = await store.load();
      expect(value).toBeNull();
    });
  });

  describe('no-op when !hasFileSystem', () => {
    it('returns default and save is a no-op', async () => {
      // Use inline mock approach for this specific test
      vi.resetModules();
      vi.doMock('$lib/platform', () => ({
        hasFileSystem: false,
        getFS: () => {
          throw new Error('should not be called');
        },
      }));
      const { persistedJson: pj } = await import('./persistedJson');
      const store = pj<string[]>({ path: TEST_PATH, defaultValue: ['default'] });

      const value = await store.load();
      expect(value).toEqual(['default']);

      // save should not throw
      await store.save(['updated']);

      // clear should not throw
      await store.clear();

      // Restore original mock
      vi.doUnmock('$lib/platform');
      vi.resetModules();
    });
  });
});
