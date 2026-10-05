#!/usr/bin/env node
// `just detached` — run a long command detached from the session that started
// it, with a durable log and exit file, so a killed session does not lose the
// work. Two major papercuts motivated it: a 16-shard corpus sweep lost to a
// parent session invalidated after four hours (pc_8292d8962c74), and the same
// sweep OOM-killed with no resumable per-shard status (pc_5dc7e3957a8e — the
// durable-status half; memory-aware concurrency is still the recipe's job).
//
//   just detached start <name> <command…>   # e.g. just detached start census just milkdown-census --limit 2000
//   just detached wait <name> [--timeout <sec>] [--lines <n>]   # blocks; exits with the command's code (124 on timeout)
//   just detached status
//   just detached tail <name> [--lines <n>]
//   just detached stop <name>               # SIGTERM to the run's own process group (identity, never a name)
//
// State lives in <worktree>/.futo/runs/<name>/ (gitignored): cmd.json, log, exit.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WRAPPER = [
  '"$@" >>"$DETACHED_LOG" 2>&1',
  'code=$?',
  'printf \'%s\\n\' "$code" > "$DETACHED_EXIT"',
].join('\n');

export function runsRoot(cwd = process.cwd(), env = process.env) {
  if (env.FUTO_DETACHED_ROOT) return env.FUTO_DETACHED_ROOT;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  const base = top.status === 0 ? top.stdout.trim() : cwd;
  return path.join(base, '.futo', 'runs');
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function readRun(dir) {
  const meta = readJson(path.join(dir, 'cmd.json'));
  if (!meta) return null;
  const exitFile = path.join(dir, 'exit');
  const exit = fs.existsSync(exitFile) ? Number(fs.readFileSync(exitFile, 'utf8').trim()) : null;
  const logFile = path.join(dir, 'log');
  const logBytes = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const alive = exit === null && pidAlive(meta.pid);
  return { name: path.basename(dir), ...meta, exit, alive, logBytes, dir };
}

export function start(name, argv, { root, cwd = process.cwd(), spawnImpl = spawn } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    throw new Error(`run name '${name}' must be [A-Za-z0-9._-]`);
  if (!argv.length) throw new Error('nothing to run');
  const dir = path.join(root, name);
  const existing = fs.existsSync(dir) ? readRun(dir) : null;
  if (existing?.alive) throw new Error(`run '${name}' is still running (pid ${existing.pid})`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, 'log');
  const exit = path.join(dir, 'exit');
  fs.writeFileSync(log, `# ${new Date().toISOString()} ${argv.join(' ')}\n`);
  const child = spawnImpl('/bin/sh', ['-c', WRAPPER, 'futo-detached', ...argv], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, DETACHED_LOG: log, DETACHED_EXIT: exit },
  });
  child.unref();
  const meta = { argv, cwd, started: new Date().toISOString(), pid: child.pid };
  fs.writeFileSync(path.join(dir, 'cmd.json'), JSON.stringify(meta, null, 2) + '\n');
  return { dir, ...meta };
}

export async function wait(
  name,
  {
    root,
    timeoutMs = Infinity,
    pollMs = 1000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  },
) {
  const dir = path.join(root, name);
  const startedAt = Date.now();
  for (;;) {
    const run = readRun(dir);
    if (!run) throw new Error(`no run named '${name}' under ${root}`);
    if (run.exit !== null) return run;
    if (!run.alive) {
      // The wrapper died without writing exit (SIGKILL, OOM): record that.
      fs.writeFileSync(path.join(dir, 'exit'), '137\n');
      return readRun(dir);
    }
    if (Date.now() - startedAt > timeoutMs) return { ...run, timedOut: true };
    await sleep(pollMs);
  }
}

export function stop(name, { root }) {
  const run = readRun(path.join(root, name));
  if (!run) throw new Error(`no run named '${name}'`);
  if (!run.alive) return run;
  try {
    process.kill(-run.pid, 'SIGTERM'); // the group the detached spawn created
  } catch {
    process.kill(run.pid, 'SIGTERM');
  }
  fs.writeFileSync(path.join(run.dir, 'exit'), '143\n');
  return readRun(run.dir);
}

export function list(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((n) => readRun(path.join(root, n)))
    .filter(Boolean)
    .sort((a, b) => String(a.started).localeCompare(String(b.started)));
}

export function tail(dir, n = 40) {
  const file = path.join(dir, 'log');
  if (!fs.existsSync(file)) return '';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n).join('\n');
}

function flagsOf(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      flags[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else flags._.push(argv[i]);
  }
  return flags;
}

async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const root = runsRoot();
  const state = (r) =>
    r.exit !== null ? `exited ${r.exit}` : r.alive ? `running pid ${r.pid}` : 'dead?';
  if (cmd === 'start') {
    const run = start(name, rest, { root });
    process.stdout.write(`started '${name}' pid ${run.pid} → ${run.dir}/log\n`);
  } else if (cmd === 'wait') {
    const flags = flagsOf(rest);
    const run = await wait(name, {
      root,
      timeoutMs: flags.timeout ? Number(flags.timeout) * 1000 : Infinity,
    });
    process.stdout.write(tail(run.dir, Number(flags.lines ?? 40)) + '\n');
    if (run.timedOut) {
      process.stderr.write(`'${name}' still running after ${flags.timeout}s (pid ${run.pid})\n`);
      process.exit(124);
    }
    process.stderr.write(`'${name}' ${state(run)}\n`);
    process.exit(run.exit ?? 1);
  } else if (cmd === 'status') {
    for (const r of list(root)) {
      process.stdout.write(
        `${r.name.padEnd(20)} ${state(r).padEnd(18)} started ${r.started}  log ${r.logBytes}B  ${r.argv.join(' ').slice(0, 60)}\n`,
      );
    }
  } else if (cmd === 'tail') {
    const flags = flagsOf(rest);
    process.stdout.write(tail(path.join(root, name), Number(flags.lines ?? 40)) + '\n');
  } else if (cmd === 'stop') {
    const r = stop(name, { root });
    process.stdout.write(`'${name}' ${state(r)}\n`);
  } else {
    process.stderr.write(
      'usage: just detached start <name> <command…> | wait <name> [--timeout s] | status | tail <name> | stop <name>\n',
    );
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
