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

    if (url.pathname === '/api/blobs' && method === 'POST') {
      const key = nextBlobKey();
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      state.blobs!.set(key, body);
      return Response.json({ key }, { status: 201 });
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

    if (url.pathname === '/api/collections/collection-1/objects' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { blob_key: string; size_bytes: number };
      const now = new Date(Date.UTC(2026, 3, 14, 12, state.collectionVersion)).toISOString();
      const object = {
        id: nextObjectId(),
        version: 1,
        changeSeq: ++state.collectionVersion!,
        blobKey: body.blob_key,
        sizeBytes: body.size_bytes,
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

    const objectMatch = url.pathname.match(/^\/api\/collections\/collection-1\/objects\/([^/]+)$/);
    if (objectMatch && method === 'PUT') {
      const object = state.objects!.get(objectMatch[1]);
      if (!object) return Response.json({ error: 'not found' }, { status: 404 });
      const body = JSON.parse(String(init?.body)) as { version: number; blob_key: string; size_bytes: number };
      if (body.version !== object.version + 1) {
        return Response.json(
          { error: 'version conflict', currentVersion: object.version, currentBlobKey: object.blobKey },
          { status: 409 },
        );
      }
      object.version = body.version;
      object.changeSeq = ++state.collectionVersion!;
      object.blobKey = body.blob_key;
      object.sizeBytes = body.size_bytes;
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
