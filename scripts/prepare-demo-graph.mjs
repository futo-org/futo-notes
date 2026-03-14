#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    vault: path.resolve(process.env.HOME ?? '', 'Documents/stonefruit-backup'),
    server: 'http://127.0.0.1:3006',
    password: 'stonefruit-demo',
    clean: false,
    timeoutMs: 30 * 60 * 1000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--vault') args.vault = path.resolve(argv[++i]);
    else if (arg === '--server') args.server = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg === '--clean') args.clean = true;
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function deterministicUuid(seed) {
  const hex = sha256Hex(seed);
  const chars = hex.slice(0, 32).split('');
  chars[12] = '4';
  const variant = parseInt(chars[16], 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  const compact = chars.join('');
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJson(file, value) {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  return { response, json };
}

async function waitForHealth(server, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${server}/health`);
      if (response.ok) {
        const health = await response.json();
        return health;
      }
    } catch {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Server ${server} did not become healthy within ${timeoutMs}ms`);
}

async function setupAndLogin(server, password) {
  const health = await waitForHealth(server, 60_000);
  if (!health.setup_complete) {
    const setup = await fetchJson(`${server}/setup`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    if (!setup.response.ok && setup.response.status !== 409) {
      throw new Error(`Setup failed: ${setup.response.status} ${JSON.stringify(setup.json)}`);
    }
  }

  const login = await fetchJson(`${server}/login`, {
    method: 'POST',
    body: JSON.stringify({ password, device_info: 'demo-graph-prep' }),
  });
  if (!login.response.ok || !login.json?.token) {
    throw new Error(`Login failed: ${login.response.status} ${JSON.stringify(login.json)}`);
  }
  return login.json.token;
}

async function cleanVault(vaultDir) {
  const entries = await fs.readdir(vaultDir, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.endsWith('.md')) {
      const target = path.join(vaultDir, entry.name);
      await fs.rm(target, { force: true });
      removed.push(entry.name);
      continue;
    }
    if (entry.isDirectory()) {
      const target = path.join(vaultDir, entry.name);
      await fs.rm(target, { recursive: true, force: true });
      removed.push(`${entry.name}/`);
    }
  }
  return removed;
}

async function collectMarkdownNotes(vaultDir) {
  const entries = await fs.readdir(vaultDir, { withFileTypes: true });
  const notes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = path.join(vaultDir, entry.name);
    const content = await fs.readFile(filePath, 'utf8');
    const stats = await fs.stat(filePath);
    const id = entry.name.slice(0, -3);
    const uuid = deterministicUuid(entry.name);
    const contentHash = sha256Hex(content);
    notes.push({
      id,
      filename: entry.name,
      uuid,
      content,
      modified_at: Math.trunc(stats.mtimeMs),
      content_hash: contentHash,
      hash_at_last_sync: '',
    });
  }

  notes.sort((a, b) => a.filename.localeCompare(b.filename));
  return notes;
}

async function syncNotes(server, token, notes) {
  const payload = {
    notes: notes.map((note) => ({
      uuid: note.uuid,
      filename: note.filename,
      modified_at: note.modified_at,
      content_hash: note.content_hash,
      hash_at_last_sync: note.hash_at_last_sync,
      content: note.content,
    })),
    all_uuids: notes.map((note) => note.uuid),
    deleted_uuids: [],
  };

  const { response, json } = await fetchJson(`${server}/sync`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Sync failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

async function setEnhancedSearch(server, token, enabled) {
  const { response, json } = await fetchJson(`${server}/search/set-enhanced-search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) {
    throw new Error(`set-enhanced-search failed: ${response.status} ${JSON.stringify(json)}`);
  }
}

async function triggerReindex(server, token) {
  const { response, json } = await fetchJson(`${server}/search/reindex`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({}),
  });
  if (!response.ok && response.status !== 202) {
    throw new Error(`Reindex failed: ${response.status} ${JSON.stringify(json)}`);
  }
}

async function pollArtifacts(server, token, timeoutMs) {
  const started = Date.now();
  let lastCaps = null;
  let lastStatus = null;

  while (Date.now() - started < timeoutMs) {
    const [capsResp, statusResp] = await Promise.all([
      fetchJson(`${server}/search/capabilities`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      fetchJson(`${server}/search/status`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    ]);

    if (!capsResp.response.ok) {
      throw new Error(`Capabilities failed: ${capsResp.response.status} ${JSON.stringify(capsResp.json)}`);
    }
    if (!statusResp.response.ok) {
      throw new Error(`Status failed: ${statusResp.response.status} ${JSON.stringify(statusResp.json)}`);
    }

    lastCaps = capsResp.json;
    lastStatus = statusResp.json;

    const completed = lastStatus?.last_run?.status === 'completed';
    const artifactsReady = Boolean(
      lastCaps?.artifact_version
      && lastCaps?.artifact_hash
      && typeof lastCaps?.dims === 'number'
      && lastCaps?.chunk_count > 0,
    );

    if (completed && artifactsReady) {
      return { capabilities: lastCaps, status: lastStatus };
    }

    if (lastStatus?.last_run?.status === 'failed') {
      throw new Error(`Index job failed: ${JSON.stringify(lastStatus.last_run)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Timed out waiting for artifacts. caps=${JSON.stringify(lastCaps)} status=${JSON.stringify(lastStatus)}`);
}

async function downloadArtifacts(server, token, vaultDir) {
  const [manifestResp, vectorsResp] = await Promise.all([
    fetch(`${server}/search/index?format=manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${server}/search/index?format=bin`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (!manifestResp.ok) {
    throw new Error(`Manifest download failed: ${manifestResp.status}`);
  }
  if (!vectorsResp.ok) {
    throw new Error(`Vector download failed: ${vectorsResp.status}`);
  }

  const manifestText = await manifestResp.text();
  const vectorBuffer = Buffer.from(await vectorsResp.arrayBuffer());

  await fs.writeFile(path.join(vaultDir, '.supersearch-manifest.json'), manifestText, 'utf8');
  await fs.writeFile(path.join(vaultDir, '.supersearch-vectors.bin'), vectorBuffer);

  return JSON.parse(manifestText);
}

async function writeLocalState({ vaultDir, server, token, notes, syncResponse, capabilities }) {
  const now = Date.now();
  const syncState = {
    hashByUuid: Object.fromEntries(notes.map((note) => [note.uuid, note.content_hash])),
    uuidById: Object.fromEntries(notes.map((note) => [note.id, note.uuid])),
    deletedUuids: [],
    serverVersion: typeof syncResponse?.version === 'number' ? syncResponse.version : undefined,
    hashCache: Object.fromEntries(notes.map((note) => [
      note.id,
      { modifiedAt: note.modified_at, hash: note.content_hash },
    ])),
  };

  const prefs = {
    appearance: { theme: 'auto' },
    crashReporting: { enabled: true, alwaysSend: false },
    sync: {
      serverUrl: server,
      token,
      lastSyncedAt: now,
      lastError: '',
    },
  };

  const supersearchState = {
    artifactVersion: capabilities.artifact_version,
    artifactHash: capabilities.artifact_hash,
    downloadedAt: now,
    model: capabilities.model,
    dims: capabilities.dims,
    chunkCount: capabilities.chunk_count,
  };

  await writeJson(path.join(vaultDir, '.sync-state-v1.json'), syncState);
  await writeJson(path.join(vaultDir, '.preferences.json'), prefs);
  await writeJson(path.join(vaultDir, '.supersearch-state.json'), supersearchState);
}

async function main() {
  const args = parseArgs(process.argv);
  await ensureDir(args.vault);

  if (args.clean) {
    const removed = await cleanVault(args.vault);
    console.log(`Cleaned ${removed.length} non-markdown entries from ${args.vault}`);
  }

  const notes = await collectMarkdownNotes(args.vault);
  if (notes.length === 0) {
    throw new Error(`No markdown notes found in ${args.vault}`);
  }

  const existingPrefs = await readJsonIfExists(path.join(args.vault, '.preferences.json'));
  if (existingPrefs?.sync?.serverUrl && existingPrefs.sync.serverUrl !== args.server) {
    console.log(`Replacing existing server URL ${existingPrefs.sync.serverUrl} with ${args.server}`);
  }

  const token = await setupAndLogin(args.server, args.password);
  const syncResponse = await syncNotes(args.server, token, notes);
  await setEnhancedSearch(args.server, token, true);
  await triggerReindex(args.server, token);
  const { capabilities } = await pollArtifacts(args.server, token, args.timeoutMs);
  const manifest = await downloadArtifacts(args.server, token, args.vault);
  await writeLocalState({
    vaultDir: args.vault,
    server: args.server,
    token,
    notes,
    syncResponse,
    capabilities,
  });

  console.log(JSON.stringify({
    vault: args.vault,
    server: args.server,
    notes: notes.length,
    chunkCount: manifest.chunk_count,
    dims: manifest.dims,
    artifactHash: capabilities.artifact_hash,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
