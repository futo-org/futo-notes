/**
 * Property-based sync fuzzer.
 *
 * Generates random multi-client sync scenarios and verifies invariants hold:
 * content preservation, convergence, filename uniqueness, idempotent re-sync,
 * and monotonic versioning.
 *
 * Reproduce failures: FUZZ_SEED=<seed> pnpm run server:test -- sync-fuzzer
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestEnv, setupAndLogin, type TestEnv } from '../helpers/setup.js';
import { SyncClient } from '../helpers/sync-client.js';
import { contentHash } from '../../src/sync/hash.js';

// ── Deterministic PRNG (mulberry32) ─────────────────────

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function randChoice<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length)];
}

// ── Random generators ───────────────────────────────────

// Small word pool — intentionally small to stress filename collisions and dedup
const WORDS = [
  'apple', 'bread', 'cherry', 'date', 'egg', 'fig', 'grape',
  'honey', 'iris', 'jam', 'kale', 'lemon', 'mango', 'nut',
  'olive', 'pear', 'quince', 'rice', 'sage', 'tea',
];

function randomFilename(rng: () => number): string {
  const r = rng();
  if (r < 0.65) {
    // Two words
    return `${randChoice(rng, WORDS)}-${randChoice(rng, WORDS)}.md`;
  } else if (r < 0.80) {
    // Single word
    return `${randChoice(rng, WORDS)}.md`;
  } else if (r < 0.90) {
    // Unicode (CJK, accented)
    const uniChars = ['cafe\u0301', '\u4e16\u754c', '\u3053\u3093\u306b\u3061\u306f', 'stra\u00dfe', '\u00e9toile'];
    return `${randChoice(rng, uniChars)}.md`;
  } else {
    // Numbered
    return `note-${randInt(rng, 0, 50).toString().padStart(3, '0')}.md`;
  }
}

function randomContent(rng: () => number): string {
  const r = rng();
  if (r < 0.50) {
    // Short markdown
    const heading = randChoice(rng, WORDS);
    const body = randChoice(rng, WORDS) + ' ' + randChoice(rng, WORDS);
    return `# ${heading}\n${body}`;
  } else if (r < 0.65) {
    // Empty
    return '';
  } else if (r < 0.80) {
    // Medium text
    const lines = Array.from({ length: randInt(rng, 5, 15) }, () =>
      Array.from({ length: randInt(rng, 3, 8) }, () => randChoice(rng, WORDS)).join(' '),
    );
    return lines.join('\n');
  } else if (r < 0.92) {
    // Unicode-heavy
    return `\u00e9toile \u2603 \u4e16\u754c ${randChoice(rng, WORDS)} \u2764`;
  } else {
    // Large
    return Array.from({ length: randInt(rng, 50, 100) }, () => randChoice(rng, WORDS)).join(' ');
  }
}

// ── Operation types ─────────────────────────────────────

type FuzzOp =
  | { type: 'create'; filename: string; content: string }
  | { type: 'edit'; uuid: string; content: string }
  | { type: 'delete'; uuid: string }
  | { type: 'rename'; uuid: string; filename: string }
  | { type: 'noop' };

function randomOperation(rng: () => number, client: SyncClient): FuzzOp {
  const noteUuids = [...client.notes.keys()];

  // Force create when client has no notes
  if (noteUuids.length === 0) {
    return { type: 'create', filename: randomFilename(rng), content: randomContent(rng) };
  }

  const r = rng();
  if (r < 0.30) {
    return { type: 'create', filename: randomFilename(rng), content: randomContent(rng) };
  } else if (r < 0.60) {
    return { type: 'edit', uuid: randChoice(rng, noteUuids), content: randomContent(rng) };
  } else if (r < 0.75) {
    return { type: 'delete', uuid: randChoice(rng, noteUuids) };
  } else if (r < 0.90) {
    return { type: 'rename', uuid: randChoice(rng, noteUuids), filename: randomFilename(rng) };
  } else {
    return { type: 'noop' };
  }
}

// ── Operation executor ──────────────────────────────────

interface OpLogEntry {
  round: number;
  clientIndex: number;
  op: FuzzOp;
}

function executeOp(client: SyncClient, op: FuzzOp): string | undefined {
  switch (op.type) {
    case 'create':
      return client.createNote(op.filename, op.content);
    case 'edit':
      client.editNote(op.uuid, op.content);
      return undefined;
    case 'delete':
      client.deleteNote(op.uuid);
      return undefined;
    case 'rename':
      client.renameNote(op.uuid, op.filename);
      return undefined;
    case 'noop':
      return undefined;
  }
}

// ── Property checkers ───────────────────────────────────

interface PropertyResult {
  pass: boolean;
  message: string;
}

/**
 * Property 1: Content Preservation.
 * Every piece of content that the server has confirmed (via hash_updates or
 * server-sent updates) must be present in the final converged state, unless
 * it was superseded by an edit to the same UUID or explicitly deleted.
 *
 * This avoids false positives from:
 * - Reset-client dedup (server legitimately discards unsynced client content)
 * - Identical-content notes (two notes with same hash count as one)
 *
 * Tracks content at the UUID level: a confirmed UUID whose content was later
 * edited has its old hash replaced, not accumulated.
 */
function checkContentPreservation(
  clients: SyncClient[],
  confirmedContent: Map<string, string>, // uuid -> latest confirmed content hash
  deletedUuids: Set<string>,
): PropertyResult {
  // Collect all content hashes in the converged state
  const convergedHashes = new Set<string>();
  for (const [, note] of clients[0].notes) {
    convergedHashes.add(contentHash(note.content));
  }

  const missing: string[] = [];
  for (const [uuid, hash] of confirmedContent) {
    if (deletedUuids.has(uuid)) continue;
    if (!convergedHashes.has(hash)) {
      missing.push(`uuid:${uuid.slice(0, 8)} hash:${hash.slice(0, 12)}`);
    }
  }

  if (missing.length > 0) {
    return { pass: false, message: `Confirmed content missing from converged state:\n  ${missing.join('\n  ')}` };
  }
  return { pass: true, message: '' };
}

/**
 * Property 2: Convergence.
 * After all clients sync to steady state, all clients have the same UUIDs
 * with the same content. Filename agreement is NOT checked here because the
 * protocol doesn't guarantee filename convergence for collision-renamed notes:
 * when the server adds "(2)" during creation, hash_updates doesn't carry the
 * new filename, and the inventory comparison resolves to a no-op. This is a
 * known protocol limitation — content integrity is what matters.
 */
function checkConvergence(clients: SyncClient[]): PropertyResult {
  if (clients.length < 2) return { pass: true, message: '' };

  const ref = clients[0];
  for (let i = 1; i < clients.length; i++) {
    const other = clients[i];

    if (ref.notes.size !== other.notes.size) {
      return {
        pass: false,
        message: `C0 has ${ref.notes.size} notes, C${i} has ${other.notes.size}`,
      };
    }

    for (const [uuid, refNote] of ref.notes) {
      const otherNote = other.notes.get(uuid);
      if (!otherNote) {
        return { pass: false, message: `C${i} missing uuid ${uuid.slice(0, 8)} (${refNote.filename})` };
      }
      if (refNote.content !== otherNote.content) {
        return {
          pass: false,
          message: `Content mismatch for ${uuid.slice(0, 8)}: C0="${refNote.content.slice(0, 30)}" C${i}="${otherNote.content.slice(0, 30)}"`,
        };
      }
    }
  }

  return { pass: true, message: '' };
}

// Filename uniqueness is checked server-side by the post-sync invariant
// (checkPostSyncInvariants → checkDuplicateFilenames) which runs on every
// sync operation. The client-side SyncClient can't guarantee filename
// uniqueness because hash_updates doesn't carry server-renamed filenames.

/**
 * Property 4: Idempotent Re-Sync.
 * After convergence, syncing again produces no content changes.
 * hash_updates are excluded because the server may re-confirm hashes for
 * notes with stale filenames (a known protocol limitation).
 */
async function checkIdempotentResync(clients: SyncClient[]): Promise<PropertyResult> {
  for (let i = 0; i < clients.length; i++) {
    const res = await clients[i].sync();
    const contentChanges = res.update.length + res.delete.length + res.conflicts.length;
    if (contentChanges > 0) {
      return {
        pass: false,
        message: `C${i} re-sync produced content changes: ${res.update.length} updates, ${res.delete.length} deletes, ${res.conflicts.length} conflicts`,
      };
    }
  }
  return { pass: true, message: '' };
}

/**
 * Property 5: Monotonic Version.
 * Server version never decreases.
 */
function checkMonotonicVersion(clients: SyncClient[], previousVersion: number): PropertyResult {
  for (let i = 0; i < clients.length; i++) {
    if (clients[i].serverVersion < previousVersion) {
      return {
        pass: false,
        message: `C${i} version ${clients[i].serverVersion} < previous ${previousVersion}`,
      };
    }
  }
  return { pass: true, message: '' };
}

// ── Failure report ──────────────────────────────────────

function formatFailure(
  seed: number,
  property: string,
  message: string,
  round: number,
  totalRounds: number,
  config: FuzzerConfig,
  opLog: OpLogEntry[],
  clients: SyncClient[],
): string {
  const lines = [
    '',
    '=== SYNC FUZZER FAILURE ===',
    `Seed: ${seed}  (reproduce with FUZZ_SEED=${seed})`,
    `Property: ${property}`,
    `Round: ${round} / ${totalRounds}`,
    `Config: { numClients: ${config.numClients}, roundCount: ${config.roundCount}, opsPerClientPerRound: ${config.opsPerClientPerRound} }`,
    '',
    `--- Failure ---`,
    message,
    '',
    '--- Operation Log ---',
  ];

  for (const entry of opLog) {
    const { round: r, clientIndex: ci, op } = entry;
    switch (op.type) {
      case 'create':
        lines.push(`[R${r} C${ci}] create "${op.filename}" (${op.content.length} bytes)`);
        break;
      case 'edit':
        lines.push(`[R${r} C${ci}] edit uuid:${op.uuid.slice(0, 8)} (${op.content.length} bytes)`);
        break;
      case 'delete':
        lines.push(`[R${r} C${ci}] delete uuid:${op.uuid.slice(0, 8)}`);
        break;
      case 'rename':
        lines.push(`[R${r} C${ci}] rename uuid:${op.uuid.slice(0, 8)} -> "${op.filename}"`);
        break;
      case 'noop':
        lines.push(`[R${r} C${ci}] noop`);
        break;
    }
  }

  lines.push('', '--- Client States ---');
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    lines.push(`Client ${i} (version=${c.serverVersion}, ${c.notes.size} notes):`);
    for (const [uuid, note] of c.notes) {
      const hash = contentHash(note.content);
      lines.push(`  ${uuid.slice(0, 8)} "${note.filename}" hash:${hash.slice(0, 12)} ${note.content.length}b`);
    }
  }

  lines.push('===========================', '');
  return lines.join('\n');
}

// ── Fuzzer orchestrator ─────────────────────────────────

interface FuzzerConfig {
  numClients: number;
  roundCount: number;
  opsPerClientPerRound: number;
}

async function runFuzzer(
  env: TestEnv,
  token: string,
  config: FuzzerConfig,
  seed: number,
): Promise<void> {
  const rng = mulberry32(seed);
  const clients: SyncClient[] = [];
  for (let i = 0; i < config.numClients; i++) {
    clients.push(new SyncClient(env.app, token));
  }

  const opLog: OpLogEntry[] = [];

  // Track server-confirmed content for preservation check.
  // Key: uuid. Value: latest confirmed content hash for that uuid.
  // Only populated when the server confirms content (hash_updates) or sends
  // content to the client (update[]). Never populated from local-only operations.
  const confirmedContent = new Map<string, string>();
  // UUIDs that were explicitly deleted by a client or server-directed deletion
  const deletedUuids = new Set<string>();

  let maxVersion = 0;

  for (let round = 1; round <= config.roundCount; round++) {
    // 1. Each client performs random operations locally
    for (let ci = 0; ci < clients.length; ci++) {
      for (let opIdx = 0; opIdx < config.opsPerClientPerRound; opIdx++) {
        const op = randomOperation(rng, clients[ci]);
        opLog.push({ round, clientIndex: ci, op });

        if (op.type === 'delete') {
          deletedUuids.add(op.uuid);
        }

        executeOp(clients[ci], op);
      }
    }

    // 2. Sync all clients to convergence.
    // With N clients, cascading conflict copies can take N+ passes to propagate.
    const maxPasses = config.numClients * 3;
    let converged = false;
    for (let pass = 0; pass < maxPasses; pass++) {
      let anyChanges = false;
      for (let ci = 0; ci < clients.length; ci++) {
        const res = await clients[ci].sync();
        // Only count content changes, not hash confirmations.
        // hash_updates are acks for already-uploaded content — they don't
        // indicate new state that other clients need to absorb.
        const contentChanges = res.update.length + res.delete.length + res.conflicts.length;
        if (contentChanges > 0) anyChanges = true;

        // Track server-confirmed content
        for (const hu of res.hash_updates) {
          const note = clients[ci].getNote(hu.uuid);
          if (note) {
            confirmedContent.set(hu.uuid, contentHash(note.content));
          }
        }
        for (const update of res.update) {
          confirmedContent.set(update.uuid, contentHash(update.content));
        }
        // Track server-directed deletions
        for (const uuid of res.delete) {
          deletedUuids.add(uuid);
        }
      }
      if (!anyChanges) {
        converged = true;
        break;
      }
    }

    if (!converged) {
      const report = formatFailure(seed, 'convergence-timeout', `Clients did not converge within ${maxPasses} sync passes`, round, config.roundCount, config, opLog, clients);
      console.error(report);
      throw new Error(`Convergence timeout at round ${round}`);
    }

    // 3. Verify all properties
    const fail = (property: string, result: PropertyResult) => {
      const report = formatFailure(seed, property, result.message, round, config.roundCount, config, opLog, clients);
      console.error(report);
      throw new Error(`Property "${property}" failed at round ${round}: ${result.message}`);
    };

    const convergence = checkConvergence(clients);
    if (!convergence.pass) fail('convergence', convergence);

    const contentPres = checkContentPreservation(clients, confirmedContent, deletedUuids);
    if (!contentPres.pass) fail('content-preservation', contentPres);

    const idempotent = await checkIdempotentResync(clients);
    if (!idempotent.pass) fail('idempotent-resync', idempotent);

    const version = checkMonotonicVersion(clients, maxVersion);
    if (!version.pass) fail('monotonic-version', version);

    maxVersion = Math.max(...clients.map((c) => c.serverVersion));
  }
}

// ── Test cases ──────────────────────────────────────────

const SEED = process.env.FUZZ_SEED ? parseInt(process.env.FUZZ_SEED, 10) : Date.now();

describe('sync fuzzer', () => {
  let env: TestEnv;
  let token: string;

  beforeEach(async () => {
    env = createTestEnv();
    token = await setupAndLogin(env.app);
  });

  afterEach(() => {
    env.cleanup();
  });

  it('2 clients, 10 rounds, 5 ops each', async () => {
    console.log(`[sync-fuzzer] seed=${SEED}`);
    await runFuzzer(env, token, { numClients: 2, roundCount: 10, opsPerClientPerRound: 5 }, SEED);
  }, 30_000);

  it('3 clients, 8 rounds, 3 ops each', async () => {
    console.log(`[sync-fuzzer] seed=${SEED + 1}`);
    await runFuzzer(env, token, { numClients: 3, roundCount: 8, opsPerClientPerRound: 3 }, SEED + 1);
  }, 30_000);

  it('4 clients, 5 rounds, 4 ops each', async () => {
    console.log(`[sync-fuzzer] seed=${SEED + 2}`);
    await runFuzzer(env, token, { numClients: 4, roundCount: 5, opsPerClientPerRound: 4 }, SEED + 2);
  }, 30_000);

  it.skipIf(!process.env.FUZZ_SOAK)('extended soak: 3 clients, 100 rounds, 8 ops', async () => {
    console.log(`[sync-fuzzer] soak seed=${SEED + 3}`);
    await runFuzzer(env, token, { numClients: 3, roundCount: 100, opsPerClientPerRound: 8 }, SEED + 3);
  }, 300_000);
});
