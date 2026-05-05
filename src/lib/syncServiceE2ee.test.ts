import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform');
vi.mock('./rustCore');

import { createNodeFS, resetActiveFS, setActiveFS, testFS, type TestPlatformFS } from '$lib/platform';

interface MockServerState {
  key: unknown | null;
  putKeyCount: number;
  blobs?: Map<string, Uint8Array>;
  blobCounter?: number;
  objects?: Map<string, {
    id: string;
    version: number;
    changeSeq: number;
    blobKey: string;
    sizeBytes: number;
    deleted: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  objectCounter?: number;
  collectionVersion?: number;
}

function installFetchMock(state: MockServerState): void {
  state.blobs ??= new Map();
  state.blobCounter ??= 0;
  state.objects ??= new Map();
  state.objectCounter ??= 0;
  state.collectionVersion ??= 0;

  const nextBlobKey = () => `user-1/blob-${++state.blobCounter!}`;
  const nextObjectId = () => `object-${++state.objectCounter!}`;
  const objectResponse = (obj: NonNullable<MockServerState['objects']> extends Map<string, infer T> ? T : never) => ({
    id: obj.id,
    collection_id: 'collection-1',
    version: obj.version,
    change_seq: obj.changeSeq,
    deleted: obj.deleted,
    blob_key: obj.blobKey,
    size_bytes: obj.sizeBytes,
    created_at: obj.createdAt,
    updated_at: obj.updatedAt,
  });

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';

    if (url.pathname === '/' && method === 'GET') {
      return Response.json({ auth_mode: 'password' });
    }

    if (url.pathname === '/api/auth/password/login' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { password?: string };
      if (!body.password) return Response.json({ error: 'password is required' }, { status: 400 });
      return Response.json({ user: { id: 'user-1' }, token: 'token-1' });
    }

    if (url.pathname === '/api/collections' && method === 'GET') {
      return Response.json({ collections: [{ id: 'collection-1' }] });
    }

    if (url.pathname === '/api/collections' && method === 'POST') {
      return Response.json({ collection: { id: 'collection-1' } }, { status: 201 });
    }

    if (url.pathname === '/api/collections/collection-1/key' && method === 'GET') {
      return Response.json({ key: state.key });
    }

    if (url.pathname === '/api/collections/collection-1/key' && method === 'PUT') {
      state.putKeyCount++;
      state.key = JSON.parse(String(init?.body));
      return Response.json({ key: state.key });
    }

    if (url.pathname.startsWith('/api/blobs/') && method === 'GET') {
      const key = decodeURIComponent(url.pathname.slice('/api/blobs/'.length));
      const data = state.blobs!.get(key);
      if (!data) return Response.json({ error: 'not found' }, { status: 404 });
      return new Response(data, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
    }

    if (url.pathname === '/api/collections/collection-1/objects' && method === 'GET') {
      const sinceVersion = Number(url.searchParams.get('sinceVersion') ?? 0);
      const objects = [...state.objects!.values()]
        .filter((obj) => obj.changeSeq > sinceVersion)
        .sort((a, b) => a.changeSeq - b.changeSeq)
        .map(objectResponse);
      return Response.json({ objects });
    }

    // Single-round-trip create: body is raw ciphertext; server mints blob key.
    if (url.pathname === '/api/collections/collection-1/blob-objects' && method === 'POST') {
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const blobKey = nextBlobKey();
      state.blobs!.set(blobKey, body);
      const now = new Date(Date.UTC(2026, 3, 14, 12, state.collectionVersion)).toISOString();
      const object = {
        id: nextObjectId(),
        version: 1,
        changeSeq: ++state.collectionVersion!,
        blobKey,
        sizeBytes: body.byteLength,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };
      state.objects!.set(object.id, object);
      return Response.json(
        { object: objectResponse(object), collectionVersion: state.collectionVersion },
        { status: 201 },
      );
    }

    const blobObjectMatch = url.pathname.match(/^\/api\/collections\/collection-1\/blob-objects\/([^/]+)$/);
    if (blobObjectMatch && method === 'PUT') {
      const object = state.objects!.get(blobObjectMatch[1]);
      if (!object) return Response.json({ error: 'not found' }, { status: 404 });
      const version = Number(url.searchParams.get('version'));
      if (!Number.isSafeInteger(version) || version < 1) {
        return Response.json({ error: 'valid ?version required' }, { status: 400 });
      }
      if (version !== object.version + 1) {
        return Response.json(
          { error: 'version conflict', currentVersion: object.version, currentBlobKey: object.blobKey },
          { status: 409 },
        );
      }
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const blobKey = nextBlobKey();
      state.blobs!.set(blobKey, body);
      object.version = version;
      object.changeSeq = ++state.collectionVersion!;
      object.blobKey = blobKey;
      object.sizeBytes = body.byteLength;
      object.updatedAt = new Date(Date.UTC(2026, 3, 14, 12, state.collectionVersion)).toISOString();
      return Response.json({ object: objectResponse(object), collectionVersion: state.collectionVersion });
    }

    return Response.json({ error: `unexpected ${method} ${url.pathname}` }, { status: 500 });
  }));
}

async function freshModules() {
  vi.resetModules();
  const appState = await import('./appState');
  const syncService = await import('./syncServiceE2ee');
  return { appState, syncService };
}

describe('syncServiceE2ee key bootstrap', () => {
  beforeEach(() => {
    resetActiveFS();
    testFS._reset();
    vi.unstubAllGlobals();
  });

  it('creates server-stored vault key material on first connect and reuses it on later connects', async () => {
    const state: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(state);

    const { appState, syncService } = await freshModules();
    await appState.loadAppState();

    await syncService.connectE2ee('http://server.test', 'correct horse');

    expect(state.putKeyCount).toBe(1);
    expect(state.key).toMatchObject({
      key_kdf: { kdf: 'pbkdf2-sha256', iterations: 100000, hash: 'SHA-256' },
    });
    expect(appState.getAppState().e2eeSalt).toBe((state.key as { key_salt: string }).key_salt);

    await syncService.disconnectE2ee();
    await syncService.connectE2ee('http://server.test', 'correct horse');

    expect(state.putKeyCount).toBe(1);
    expect(appState.getAppState().e2eeCollectionId).toBe('collection-1');
  });

  it('rejects an existing vault when the password cannot unwrap the vault key', async () => {
    const state: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(state);

    let modules = await freshModules();
    await modules.appState.loadAppState();
    await modules.syncService.connectE2ee('http://server.test', 'right-password');
    await modules.syncService.disconnectE2ee();

    modules = await freshModules();
    await modules.appState.loadAppState();
    await expect(
      modules.syncService.connectE2ee('http://server.test', 'wrong-password'),
    ).rejects.toThrow('Could not unlock vault key');
  });
});

async function loadClient(fs: TestPlatformFS) {
  setActiveFS(fs);
  const modules = await freshModules();
  await modules.appState.loadAppState();
  return modules;
}

describe('syncServiceE2ee conflict resolution', () => {
  beforeEach(() => {
    resetActiveFS();
    testFS._reset();
    vi.unstubAllGlobals();
  });

  it('three-way merges non-overlapping paragraph edits', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    const base = [
      '# Plan',
      '',
      'Paragraph one stays stable.',
      '',
      'Paragraph two belongs to A.',
      '',
      'Paragraph three belongs to B.',
    ].join('\n');
    await fsA.writeNote('shared', base);
    await clientA.syncService.syncE2ee('password');

    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    await clientB.syncService.syncE2ee('password');
    expect(await fsB.readNote('shared')).toBe(base);

    await fsA.writeNote('shared', base.replace('Paragraph two belongs to A.', 'Paragraph two was edited by A.'));
    await fsB.writeNote('shared', base.replace('Paragraph three belongs to B.', 'Paragraph three was edited by B.'));

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');

    setActiveFS(fsB);
    const bResult = await clientB.syncService.syncE2ee('password');
    expect(bResult.conflicts).toBe(0);
    expect(await fsB.readNote('shared')).toBe(
      base
        .replace('Paragraph two belongs to A.', 'Paragraph two was edited by A.')
        .replace('Paragraph three belongs to B.', 'Paragraph three was edited by B.'),
    );

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');
    expect(await fsA.readNote('shared')).toBe(await fsB.readNote('shared'));
  });

  it('falls back to a conflict copy when the merge ancestor is no longer on the server', async () => {
    // Simulates the server having GC'd the ancestor blob past the 1-year
    // retention window. Without the ancestor, 3-way merge is impossible; the
    // client must fall back to a conflict copy rather than surface a hard
    // error.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    const base = '# Shared\n\nline one\n\nline two\n';
    await fsA.writeNote('shared', base);
    await clientA.syncService.syncE2ee('password');

    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    await clientB.syncService.syncE2ee('password');

    // Non-overlapping edits — in the normal path this would merge cleanly.
    await fsA.writeNote('shared', base.replace('line one', 'line one edited by A'));
    await fsB.writeNote('shared', base.replace('line two', 'line two edited by B'));

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');

    // Wipe the ancestor blob from the server — simulate GC. B's objectMap
    // still references the blob it last pulled; resolveUpdateConflict will
    // get 404 when it tries to fetch the ancestor.
    const allKeys = [...server.blobs!.keys()];
    const liveKey = allKeys[allKeys.length - 1];
    for (const k of allKeys) if (k !== liveKey) server.blobs!.delete(k);

    setActiveFS(fsB);
    const bResult = await clientB.syncService.syncE2ee('password');
    // No ancestor → fall through to conflict copy.
    expect(bResult.conflicts).toBe(1);
    const bFiles = await fsB.listNoteFiles();
    expect(bFiles.some((f) => f.name.includes('conflict'))).toBe(true);
  });

  it('falls back to a conflict copy for overlapping edits', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    await fsA.writeNote('shared', '# Original');
    await clientA.syncService.syncE2ee('password');

    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    await clientB.syncService.syncE2ee('password');

    await fsA.writeNote('shared', "# A's version");
    await fsB.writeNote('shared', "# B's version");

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');

    setActiveFS(fsB);
    const bResult = await clientB.syncService.syncE2ee('password');
    expect(bResult.conflicts).toBe(1);
    expect(await fsB.readNote('shared')).toBe("# A's version");
    const bFiles = await fsB.listNoteFiles();
    const conflictFile = bFiles.find((file) => file.name.includes('conflict'));
    expect(conflictFile?.name).toBeTruthy();
    expect(await fsB.readNote(conflictFile!.name.replace(/\.md$/i, ''))).toBe("# B's version");

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');
    const aFiles = await fsA.listNoteFiles();
    expect(aFiles.some((file) => file.name.includes('conflict'))).toBe(true);
  });
});

describe('syncServiceE2ee mtime sync', () => {
  beforeEach(() => {
    resetActiveFS();
    testFS._reset();
    vi.unstubAllGlobals();
  });

  it('sets local mtime to server updated_at after push so every device sorts alike', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');

    // Write a note on A with a local mtime far in the past, so if push does
    // nothing to the local mtime we'd see the ancient value below.
    await fsA.writeNote('old-note', '# old', 1_000_000);
    const preA = (await fsA.listNoteFiles()).find((f: { name: string; mtime: number }) => f.name === 'old-note.md');
    expect(preA?.mtime).toBeLessThan(1_000_001);

    await clientA.syncService.syncE2ee('password');

    // After push, A's local mtime should match the server's updated_at for
    // this note — mock server stamps updated_at as 2026-04-14T12:mm:00Z.
    const postA = (await fsA.listNoteFiles()).find((f: { name: string; mtime: number }) => f.name === 'old-note.md');
    expect(postA?.mtime).toBeGreaterThan(new Date('2026-01-01').getTime());

    // B pulls it. B's mtime is also derived from server updated_at (via
    // Rust's `modified_at` application in the pull path, which the mock
    // honors via writeNote). A and B should agree.
    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    await clientB.syncService.syncE2ee('password');
    const postB = (await fsB.listNoteFiles()).find((f: { name: string; mtime: number }) => f.name === 'old-note.md');
    expect(postB?.mtime).toBe(postA?.mtime);
  });
});

describe('syncServiceE2ee reconcile on empty objectMap', () => {
  beforeEach(() => {
    resetActiveFS();
    testFS._reset();
    vi.unstubAllGlobals();
  });

  it('reconnect with identical local content does not re-upload anything', async () => {
    // Simulates the user's scenario: server data dir kept across a fresh
    // server, client disconnect-reconnect on the same filesystem. Without
    // reconcile-first, every note would be re-uploaded as a new object.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fs = createNodeFS();

    // First connect: write notes and push them up.
    const client1 = await loadClient(fs);
    await client1.syncService.connectE2ee('http://server.test', 'password');
    for (let i = 0; i < 5; i++) {
      await fs.writeNote(`note-${i}`, `# note ${i}\n\nbody ${i}\n`);
    }
    await client1.syncService.syncE2ee('password');
    expect(server.objects!.size).toBe(5);
    const baselineObjectIds = new Set([...server.objects!.keys()]);
    const baselineBlobCount = server.blobs!.size;

    // Disconnect: clears e2eeObjectMap (the user's "reset connection" path).
    await client1.syncService.disconnectE2ee();

    // Reconnect with the same FS. objectMap is empty; reconcile must
    // populate it from server state without uploading anything new.
    const client2 = await loadClient(fs);
    await client2.syncService.connectE2ee('http://server.test', 'password');
    const summary = await client2.syncService.syncE2ee('password');

    // The actual fix: no new objects, no new blobs.
    expect(server.objects!.size).toBe(5);
    expect(new Set([...server.objects!.keys()])).toEqual(baselineObjectIds);
    expect(server.blobs!.size).toBe(baselineBlobCount);
    expect(summary.uploaded).toBe(0);
    expect(summary.conflicts).toBe(0);

    // Map should be repopulated so subsequent edit-then-sync uses
    // updateObjectInline (PUT) rather than createObjectInline (POST).
    await fs.writeNote('note-0', '# note 0\n\nedited\n');
    const editSummary = await client2.syncService.syncE2ee('password');
    expect(editSummary.uploaded).toBe(1);
    expect(server.objects!.size).toBe(5);
  });

  it('preserves local mtime for reconcile-divergent files instead of stomping with server-now', async () => {
    // User scenario: laptop has pre-existing notes from prior syncs, then
    // reinstalls the app (or reconnects). The laptop's objectMap is empty.
    // For each note where local content differs from server, reconcile
    // records the entry with no mtimeMs slot, so push re-uploads the local
    // copy. Before the fix, push then stamped the local file's mtime to
    // the server's freshly-minted updated_at — pushing every diverged note
    // above genuinely-recent notes (the desktop's "yesterday" daily note)
    // in the sidebar.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    // Desktop (A): two older notes, then a fresh "today" note. Mock server
    // stamps updated_at with the collectionVersion → strictly increasing.
    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    await fsA.writeNote('old-1', '# old 1 — server version\n');
    await fsA.writeNote('old-2', '# old 2 — server version\n');
    await clientA.syncService.syncE2ee('password');
    await fsA.writeNote('today', '# today\n');
    await clientA.syncService.syncE2ee('password');

    // Laptop (B): pre-existing local copies of the two older notes with
    // diverged content and ancient local mtimes. No `today` note locally.
    // Empty objectMap → reconcile path runs.
    await fsB.writeNote('old-1', '# old 1 — laptop divergent\n', 1_000_000);
    await fsB.writeNote('old-2', '# old 2 — laptop divergent\n', 1_000_000);

    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    const summary = await clientB.syncService.syncE2ee('password');

    // Sanity: both diverged files were uploaded (matches user's "Uploading 2 notes").
    expect(summary.uploaded).toBe(2);

    const files = await fsB.listNoteFiles();
    const today = files.find((f: { name: string; mtime: number }) => f.name === 'today.md')!;
    const old1 = files.find((f: { name: string; mtime: number }) => f.name === 'old-1.md')!;
    const old2 = files.find((f: { name: string; mtime: number }) => f.name === 'old-2.md')!;
    expect(today).toBeDefined();
    expect(old1).toBeDefined();
    expect(old2).toBeDefined();

    // The user's complaint, distilled: the recently-created note must come
    // out at the top of an mtime-desc sort, not below freshly-pushed-but-
    // logically-old notes whose mtimes were stomped to "now".
    expect(today.mtime).toBeGreaterThan(old1.mtime);
    expect(today.mtime).toBeGreaterThan(old2.mtime);
  });

  it('reconnect with one diverged file uploads only that file', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fs = createNodeFS();

    const client1 = await loadClient(fs);
    await client1.syncService.connectE2ee('http://server.test', 'password');
    await fs.writeNote('a', '# a\n');
    await fs.writeNote('b', '# b\n');
    await fs.writeNote('c', '# c\n');
    await client1.syncService.syncE2ee('password');
    await client1.syncService.disconnectE2ee();

    // Diverge one file locally before reconnect.
    await fs.writeNote('b', '# b — local edit while disconnected\n');

    const client2 = await loadClient(fs);
    await client2.syncService.connectE2ee('http://server.test', 'password');
    const summary = await client2.syncService.syncE2ee('password');

    // Only the diverged file should be uploaded as an update; no new
    // objects created.
    expect(server.objects!.size).toBe(3);
    expect(summary.uploaded).toBe(1);
    expect(summary.conflicts).toBe(0);
    // Local content for the diverged file is preserved.
    expect(await fs.readNote('b')).toBe('# b — local edit while disconnected\n');
  });

  it('reconnect with extra server file writes it locally without re-uploading', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    // Client A creates two notes.
    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    await fsA.writeNote('shared', '# shared\n');
    await fsA.writeNote('only-a', '# only on A\n');
    await clientA.syncService.syncE2ee('password');
    const baselineBlobs = server.blobs!.size;

    // Client B has only the shared note locally, then connects fresh —
    // reconcile must pull `only-a` and not re-upload `shared`.
    await fsB.writeNote('shared', '# shared\n');
    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    const summary = await clientB.syncService.syncE2ee('password');

    expect(server.objects!.size).toBe(2);
    expect(server.blobs!.size).toBe(baselineBlobs);
    expect(summary.uploaded).toBe(0);
    expect(await fsB.readNote('only-a')).toBe('# only on A\n');
  });

  it('emits reconciling progress events with current/total', async () => {
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fs = createNodeFS();

    const client1 = await loadClient(fs);
    await client1.syncService.connectE2ee('http://server.test', 'password');
    for (let i = 0; i < 4; i++) {
      await fs.writeNote(`n-${i}`, `body ${i}`);
    }
    await client1.syncService.syncE2ee('password');
    await client1.syncService.disconnectE2ee();

    const events: Array<{ phase: string; current: number; total: number }> = [];
    const client2 = await loadClient(fs);
    client2.syncService.setSyncProgressListener((p) => events.push({ ...p }));
    await client2.syncService.connectE2ee('http://server.test', 'password');
    await client2.syncService.syncE2ee('password');
    client2.syncService.setSyncProgressListener(null);

    const reconcileEvents = events.filter((e) => e.phase === 'reconciling');
    expect(reconcileEvents.length).toBeGreaterThan(0);
    expect(reconcileEvents[0]).toMatchObject({ current: 0, total: 4 });
    expect(reconcileEvents[reconcileEvents.length - 1]).toMatchObject({ current: 4, total: 4 });
  });
});

describe('syncServiceE2ee peer-change classification', () => {
  beforeEach(() => {
    resetActiveFS();
    testFS._reset();
    vi.unstubAllGlobals();
  });

  it('omits self-pushed updates from peerUpdatedIds', async () => {
    // Typing-driven sync: the user wrote a note locally, push uploads it,
    // pull sees nothing new. peerUpdatedIds should be empty so the sync
    // manager skips the post-sync rescan + search-index persist.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fs = createNodeFS();

    const client = await loadClient(fs);
    await client.syncService.connectE2ee('http://server.test', 'password');
    await fs.writeNote('typed-note', 'body\n');
    const summary = await client.syncService.syncE2ee('password');

    expect(summary.updatedIds).toContain('typed-note');
    expect(summary.peerUpdatedIds).toEqual([]);
    expect(summary.peerDeletedIds).toEqual([]);
  });

  it('reports pull-driven updates in peerUpdatedIds', async () => {
    // Peer-side change: client A pushes, client B pulls. B's summary
    // should classify the new note as peer-driven so the rescan fires.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    await fsA.writeNote('from-a', '# from a\n');
    await clientA.syncService.syncE2ee('password');

    setActiveFS(fsB);
    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    const bSummary = await clientB.syncService.syncE2ee('password');

    expect(bSummary.peerUpdatedIds).toContain('from-a');
  });

  it('reports conflict-resolved ids in peerUpdatedIds', async () => {
    // Push-side conflict resolution still rewrites local files, so the
    // sync manager needs to know to refresh — even though it surfaced
    // through pushResult.updatedIds, not pullResult.updatedIds.
    const server: MockServerState = { key: null, putKeyCount: 0 };
    installFetchMock(server);
    const fsA = createNodeFS();
    const fsB = createNodeFS();

    const clientA = await loadClient(fsA);
    await clientA.syncService.connectE2ee('http://server.test', 'password');
    const base = '# Plan\n\npara A.\n\npara B.\n';
    await fsA.writeNote('shared', base);
    await clientA.syncService.syncE2ee('password');

    const clientB = await loadClient(fsB);
    await clientB.syncService.connectE2ee('http://server.test', 'password');
    await clientB.syncService.syncE2ee('password');

    await fsA.writeNote('shared', base.replace('para A.', 'para A edited.'));
    await fsB.writeNote('shared', base.replace('para B.', 'para B edited.'));

    setActiveFS(fsA);
    await clientA.syncService.syncE2ee('password');

    setActiveFS(fsB);
    const bSummary = await clientB.syncService.syncE2ee('password');

    expect(bSummary.peerUpdatedIds).toContain('shared');
  });
});
