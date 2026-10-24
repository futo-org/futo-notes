#!/usr/bin/env node
/** Memory-bounded, resumable foreign corpus sweeps (`just gauntlet-milkdown-sweep`).
 * Every shard gets its own systemd user service and cgroup, durable log/exit
 * files, a private fresh bundle, and isolated Playwright artifacts. A run name
 * can resume only the same clean commit, corpus, config and exact bundle hash.
 * Run the scheduler through `just detached` to survive terminal loss; its
 * services survive even if the scheduler exits. Never kills peer processes.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const require = createRequire(import.meta.url);
const GiB = 1024 ** 3;
const usage =
  'just gauntlet-milkdown-sweep <name> [--shards N] [--max-parallel N] [--memory-gib N] [--reserve-gib N]';
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function hashFile(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function cleanHead(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
    throw new Error(
      'corpus sweep requires a clean worktree so resumed evidence has one source identity',
    );
  return head;
}
export function memorySlots({ available, reserve, perShard, maxParallel }) {
  return Math.max(0, Math.min(maxParallel, Math.floor((available - reserve) / perShard)));
}
function availableMemory() {
  let bytes = os.freemem();
  try {
    const match = fs.readFileSync('/proc/meminfo', 'utf8').match(/^MemAvailable:\s+(\d+) kB$/m);
    if (match) bytes = Number(match[1]) * 1024;
    const limit = Number(fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8'));
    const used = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    if (Number.isFinite(limit)) bytes = Math.min(bytes, Math.max(0, limit - used));
  } catch {
    /* Non-Linux tests use the OS estimate; the CLI requires Linux. */
  }
  return bytes;
}
export function resumableShard(plan, index, status, report) {
  return (
    status?.fingerprint === plan.fingerprint &&
    status.index === index &&
    status.exitCode === 0 &&
    report?.corpusSha256 === plan.corpusSha256 &&
    report.shard?.index === index &&
    report.shard.count === plan.shards &&
    report.config?.candidateRevision === plan.head &&
    report.config.corpusSha256 === plan.corpusSha256 &&
    report.config.shardCount === plan.shards &&
    report.config.expectedRecords === plan.expectedRecords &&
    report.config.maxNotes === null &&
    report.config.artifactCapture === 'off-retry-on-failure' &&
    report.corpus?.reachedEof === true
  );
}
export function serviceArgs({ root, dir, memoryBytes, unit, script: entry, node, index }) {
  return [
    '--user',
    '--collect',
    `--unit=${unit}`,
    `--property=MemoryMax=${memoryBytes}`,
    '--property=MemorySwapMax=0',
    '--property=OOMPolicy=kill',
    `--property=WorkingDirectory=${root}`,
    `--property=StandardOutput=append:${path.join(dir, `shard-${index}.log`)}`,
    `--property=StandardError=append:${path.join(dir, `shard-${index}.log`)}`,
    node,
    entry,
    '--shard',
    dir,
    String(index),
  ];
}
function unitName(dir, index) {
  return `futo-corpus-${hash(dir).slice(0, 16)}-${index}`;
}
function activeUnit(unit) {
  const result = spawnSync(
    'systemctl',
    ['--user', 'show', `${unit}.service`, '--property=ActiveState', '--value'],
    { encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 && !/not found|not be found|not loaded/i.test(result.stderr))
    throw new Error(`cannot inspect ${unit}: ${result.stderr.trim()}`);
  return ['active', 'activating', 'reloading', 'deactivating'].includes(result.stdout.trim());
}
function shardPaths(dir, index) {
  return {
    status: path.join(dir, `shard-${index}.exit.json`),
    report: path.join(dir, `shard-${index}.json`),
  };
}
async function runShard(dir, index) {
  const plan = readJson(path.join(dir, 'plan.json'));
  if (!plan || !Number.isInteger(index) || index < 0 || index >= plan.shards)
    throw new Error('invalid shard or missing plan');
  const files = shardPaths(dir, index);
  let exitCode;
  try {
    if (cleanHead(plan.root) !== plan.head)
      throw new Error('source commit changed since sweep preparation');
    // Remove exact stale evidence from this runner before launching its retry.
    for (const file of [files.status, files.report]) fs.rmSync(file, { force: true });
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith('EDITOR_GAUNTLET_') || key.startsWith('VITE_')) delete env[key];
    }
    const child = spawn(
      process.execPath,
      [
        path.join(plan.root, 'node_modules/@playwright/test/cli.js'),
        'test',
        '--config',
        'playwright.editor-gauntlet.config.ts',
        'milkdown-foreign-preservation.spec.ts',
        '--workers=1',
        '--reporter=line',
        `--output=${path.join(dir, `playwright-${index}`)}`,
      ],
      {
        cwd: plan.root,
        stdio: 'inherit',
        env: {
          ...env,
          ...plan.buildEnv,
          ...plan.testEnv,
          EDITOR_GAUNTLET_CORPUS: plan.corpus,
          EDITOR_GAUNTLET_EXPECTED_RECORDS: String(plan.expectedRecords),
          EDITOR_GAUNTLET_CANDIDATE_REVISION: plan.head,
          EDITOR_GAUNTLET_ARTIFACT_CAPTURE: 'off-retry-on-failure',
          EDITOR_GAUNTLET_SHARD_INDEX: String(index),
          EDITOR_GAUNTLET_SHARD_COUNT: String(plan.shards),
          EDITOR_GAUNTLET_REPORT_PATH: files.report,
          FUTO_EDITOR_EMBED_EXPECTED_SHA256: plan.bundleSha256,
        },
      },
    );
    exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code ?? 1));
    });
    if (cleanHead(plan.root) !== plan.head)
      throw new Error('source commit changed while the shard ran');
    if (
      exitCode === 0 &&
      !resumableShard(
        plan,
        index,
        { fingerprint: plan.fingerprint, index, exitCode },
        readJson(files.report),
      )
    )
      throw new Error('successful process did not produce its matching complete shard report');
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }
  writeJson(files.status, {
    fingerprint: plan.fingerprint,
    index,
    exitCode,
    ended: new Date().toISOString(),
  });
  process.exitCode = exitCode;
}
function parse(argv) {
  const opts = {
    name: null,
    shards: 16,
    maxParallel: 2,
    memoryBytes: 6 * GiB,
    reserveBytes: 4 * GiB,
  };
  const flags = {
    '--shards': 'shards',
    '--max-parallel': 'maxParallel',
    '--memory-gib': 'memoryBytes',
    '--reserve-gib': 'reserveBytes',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flags[flag]) {
      const value = Number(argv[++i]);
      opts[flags[flag]] = flag.endsWith('-gib') ? value * GiB : value;
    } else if (!opts.name && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(flag)) opts.name = flag;
    else throw new Error(`unknown argument ${flag}; ${usage}`);
  }
  if (
    !opts.name ||
    Object.entries(opts).some(
      ([key, value]) => key !== 'name' && (!Number.isSafeInteger(value) || value < 1),
    )
  )
    throw new Error(usage);
  return opts;
}
async function prepare(opts, root, dir) {
  if (!process.env.EDITOR_GAUNTLET_CORPUS)
    throw new Error('set EDITOR_GAUNTLET_CORPUS after reading its NOTICE');
  const corpus = fs.realpathSync(process.env.EDITOR_GAUNTLET_CORPUS);
  const expectedRecords = Number(process.env.EDITOR_GAUNTLET_EXPECTED_RECORDS);
  if (!Number.isSafeInteger(expectedRecords) || expectedRecords < 1)
    throw new Error('set EDITOR_GAUNTLET_EXPECTED_RECORDS to the full corpus count');
  if (opts.shards > expectedRecords)
    throw new Error('shard count exceeds expected records; empty shards cannot prove a sweep');
  if (process.env.EDITOR_GAUNTLET_CORPUS_LIMIT)
    throw new Error('resumable sweeps do not accept EDITOR_GAUNTLET_CORPUS_LIMIT');
  const testEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('EDITOR_GAUNTLET_'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  for (const key of [
    'EDITOR_GAUNTLET_REPORT_PATH',
    'EDITOR_GAUNTLET_SHARD_INDEX',
    'EDITOR_GAUNTLET_CANDIDATE_REVISION',
  ])
    delete testEnv[key];
  const buildEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => key.startsWith('VITE_'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const config = {
    schema: 1,
    ...opts,
    root,
    corpus,
    expectedRecords,
    head: cleanHead(root),
    corpusSha256: await hashFile(corpus),
    testEnv,
    buildEnv,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  };
  const previous = readJson(path.join(dir, 'plan.json'));
  if (previous) {
    const { bundleSha256, fingerprint, ...previousConfig } = previous;
    if (fingerprint !== hash(JSON.stringify({ config: previousConfig, bundleSha256 })))
      throw new Error('sweep plan fingerprint is invalid');
    if (JSON.stringify(config) !== JSON.stringify(previousConfig))
      throw new Error('run identity changed; choose a new run name instead of reusing its reports');
    if ((await hashFile(path.join(dir, 'editor.html'))) !== previous.bundleSha256)
      throw new Error('sweep bundle snapshot changed');
    return previous;
  }
  fs.mkdirSync(dir); // A partial or unrelated directory is never silently adopted.
  const { default: buildBundle } = await import('../editorEmbedBundle.ts');
  const cleanup = await buildBundle();
  let bundleSha256;
  try {
    const bytes = fs.readFileSync(process.env.FUTO_EDITOR_EMBED_BUNDLE_PATH);
    bundleSha256 = hash(bytes);
    fs.writeFileSync(path.join(dir, 'editor.html'), bytes);
  } finally {
    cleanup();
  }
  if (cleanHead(root) !== config.head) throw new Error('source changed during bundle preparation');
  const plan = {
    ...config,
    bundleSha256,
    fingerprint: hash(JSON.stringify({ config, bundleSha256 })),
  };
  writeJson(path.join(dir, 'plan.json'), plan);
  return plan;
}
export async function withSchedulerLock(file, command) {
  const child = spawn('flock', ['--nonblock', '--conflict-exit-code', '73', file, ...command], {
    stdio: 'inherit',
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
async function sweep(argv, locked = false) {
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }
  const opts = parse(argv);
  if (process.platform !== 'linux')
    throw new Error(
      'corpus sweep services require Linux systemd; use individual shard recipes elsewhere',
    );
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  execFileSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
  const parent = path.join(root, 'tests/editor-gauntlet/local/sweeps');
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, opts.name);
  if (!locked) {
    process.exitCode = await withSchedulerLock(path.join(parent, `.${opts.name}.lock`), [
      process.execPath,
      '--experimental-strip-types',
      script,
      '--locked',
      ...argv,
    ]);
    if (process.exitCode === 73)
      console.error(`another scheduler already owns sweep ${opts.name}; inspect that run instead`);
    return;
  }
  const plan = await prepare(opts, root, dir);
  const waiting = new Set();
  const running = new Set();
  const failed = new Set();
  for (let index = 0; index < plan.shards; index++) {
    const files = shardPaths(dir, index);
    if (activeUnit(unitName(dir, index))) running.add(index);
    else if (!resumableShard(plan, index, readJson(files.status), readJson(files.report)))
      waiting.add(index);
  }
  console.log(
    `sweep ${opts.name}: ${plan.shards - waiting.size - running.size} complete, ${running.size} active, ${waiting.size} pending; ${dir}`,
  );
  while (waiting.size || running.size) {
    const slots = memorySlots({
      available: availableMemory(),
      reserve: plan.reserveBytes,
      perShard: plan.memoryBytes,
      maxParallel: plan.maxParallel,
    });
    while (waiting.size && running.size < slots) {
      if (cleanHead(root) !== plan.head)
        throw new Error('source commit changed while scheduling shards');
      const index = waiting.values().next().value;
      const files = shardPaths(dir, index);
      fs.rmSync(files.status, { force: true });
      const result = spawnSync(
        'systemd-run',
        serviceArgs({
          root,
          dir,
          memoryBytes: plan.memoryBytes,
          unit: unitName(dir, index),
          script,
          node: process.execPath,
          index,
        }),
        { encoding: 'utf8' },
      );
      if (result.status !== 0)
        throw new Error(`cannot start shard ${index}: ${result.stderr ?? result.error}`);
      waiting.delete(index);
      running.add(index);
      console.log(
        `started shard ${index} (${unitName(dir, index)}.service); memory cap ${plan.memoryBytes / GiB} GiB`,
      );
    }
    if (!running.size && waiting.size)
      throw new Error(
        'not enough available memory for one shard plus reserved headroom; resume later',
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    for (const index of running) {
      if (activeUnit(unitName(dir, index))) continue;
      running.delete(index);
      const files = shardPaths(dir, index);
      if (!resumableShard(plan, index, readJson(files.status), readJson(files.report)))
        failed.add(index);
      if (!readJson(files.status))
        writeJson(files.status, {
          fingerprint: plan.fingerprint,
          index,
          exitCode: 1,
          reason:
            'service stopped without terminal status; inspect its log and journalctl --user -u ' +
            unitName(dir, index),
        });
      console.log(
        `shard ${index}: ${failed.has(index) ? 'FAILED (resume reruns it)' : 'complete'}`,
      );
    }
  }
  if (failed.size)
    throw new Error(
      `failed shards: ${[...failed].join(', ')}; inspect per-shard logs and rerun the same command to resume`,
    );
  execFileSync(
    process.execPath,
    [
      require.resolve('tsx/cli'),
      path.join(root, 'tests/editor-gauntlet/aggregateForeignReports.ts'),
      '--output',
      path.join(dir, 'aggregate.json'),
      ...Array.from({ length: plan.shards }, (_, i) => shardPaths(dir, i).report),
    ],
    { cwd: root, stdio: 'inherit' },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  (args[0] === '--shard'
    ? runShard(args[1], Number(args[2]))
    : args[0] === '--locked'
      ? sweep(args.slice(1), true)
      : sweep(args)
  ).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
