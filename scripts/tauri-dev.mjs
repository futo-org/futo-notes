#!/usr/bin/env node
/**
 * Worktree-aware wrapper for `pnpm run tauri:dev`.
 *
 * When run from the main repo:
 *   - Points notes to ~/Documents/fake-notes (never touches ~/Documents/stonefruit)
 *   - Seeds fake-notes with test notes on first launch
 *
 * When run from a git worktree it automatically:
 *   - Assigns a unique Vite port (5200–5249) derived from the worktree path
 *   - Uses a unique app identifier to avoid D-Bus single-instance conflicts
 *   - Isolates app data to {worktree}/.tauri-data/ so the real vault is untouched
 *   - Starts an isolated sync server on a unique port (3100–3149)
 *   - Pre-writes .preferences.json so the app auto-connects to the isolated server
 *   - Seeds a small test vault on first launch
 *
 * Password for the isolated server: testing123
 */
import { createHash } from 'crypto'
import { execSync, spawn } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim()

// Worktrees have .git as a file; the main repo has it as a directory.
const isWorktree = statSync(join(repoRoot, '.git')).isFile()

const WAYLAND_ENV = {
  WINIT_UNIX_BACKEND: 'wayland',
  GDK_BACKEND: 'wayland',
  WEBKIT_DISABLE_DMABUF_RENDERER: '1',
}

;(async () => {
if (!isWorktree) {
  // Main repo: point notes at ~/Documents/fake-notes so the real vault is untouched.
  const dataDir = join(repoRoot, '.tauri-data')
  const notesDir = join(homedir(), 'Documents', 'fake-notes')

  mkdirSync(notesDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'notes-dir-override.json'),
    JSON.stringify({ notesDir }, null, 2) + '\n'
  )

  // Seed test notes if none exist yet.
  if (readdirSync(notesDir).filter((f) => f.endsWith('.md')).length === 0) {
    writeFileSync(join(notesDir, 'welcome.md'), '# Welcome\n\nThis is the dev notes vault. Your real vault is in `~/Documents/stonefruit`.\n')
    writeFileSync(join(notesDir, 'test note.md'), '# Test Note\n\nA sample note for development testing.\n')
    writeFileSync(join(notesDir, 'another note.md'), '# Another Note\n\nUseful for testing [[test note]] links and search.\n')
  }

  console.log(`[tauri-dev] main repo | notes: ${notesDir}`)

  const child = spawn(
    'cargo',
    ['tauri', 'dev', '--config', 'src-tauri/tauri.dev.conf.json'],
    {
      cwd: join(repoRoot, 'apps/tauri'),
      env: { ...process.env, ...WAYLAND_ENV, STONEFRUIT_DATA_DIR: dataDir },
      stdio: 'inherit',
    }
  )
  child.on('exit', (code) => process.exit(code ?? 0))
} else {
  // Worktree: derive a stable slot from the worktree path (matches /verify skill algorithm).
  const slot = parseInt(
    createHash('md5').update(repoRoot).digest('hex').slice(0, 8),
    16
  ) % 50

  const vitePort = 5200 + slot
  const serverPort = 3100 + slot
  const identifier = `com.futo.notes.dev.wt${slot}`
  const dataDir = join(repoRoot, '.tauri-data')
  const notesDir = join(dataDir, 'notes')

  // Install dependencies if missing (worktrees need their own node_modules).
  if (!existsSync(join(repoRoot, 'node_modules'))) {
    console.log('[tauri-dev] node_modules missing — running pnpm install…')
    execSync('pnpm install', { cwd: repoRoot, stdio: 'inherit' })
  }

  // Set up isolated notes dir.
  mkdirSync(notesDir, { recursive: true })
  writeFileSync(
    join(dataDir, 'notes-dir-override.json'),
    JSON.stringify({ notesDir }, null, 2) + '\n'
  )

  // Seed test notes if none exist yet.
  if (readdirSync(notesDir).filter((f) => f.endsWith('.md')).length === 0) {
    writeFileSync(
      join(notesDir, 'welcome.md'),
      '# Welcome\n\nThis is a worktree dev instance of Stonefruit.\n\nNotes here are isolated from your real vault.\n'
    )
    writeFileSync(
      join(notesDir, 'test note.md'),
      '# Test Note\n\nA sample note for testing. Try editing, linking, and syncing.\n'
    )
    writeFileSync(
      join(notesDir, 'another note.md'),
      '# Another Note\n\nUseful for testing [[test note]] links and search.\n'
    )
  }

  // Start isolated sync server.
  console.log(`[tauri-dev] Starting isolated server on port ${serverPort}…`)
  const serverProc = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: join(repoRoot, 'apps/server'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(serverPort),
      DATABASE_PATH: join(dataDir, 'server.db'),
      NOTES_PATH: join(dataDir, 'server-notes'),
      SEARCH_ENABLED: 'false', // skip heavy indexing in dev
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`))
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  serverProc.on('exit', (code) => {
    if (code !== null) console.error(`[tauri-dev] server exited with code ${code}`)
  })

  // Kill server when this process exits.
  process.on('exit', () => serverProc.kill())
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

  async function waitForServer(maxMs = 30_000) {
    const url = `http://localhost:${serverPort}/health`
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url)
        if (r.ok) return true
      } catch {}
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  async function loginAndWritePrefs() {
    console.log(`[tauri-dev] Waiting for server on port ${serverPort}…`)
    const up = await waitForServer()
    if (!up) {
      console.error(`[tauri-dev] Server did not start within 30s — continuing without sync config`)
      return
    }

    // Dev server auto-sets password 'testing123' on startup.
    const loginResp = await fetch(`http://localhost:${serverPort}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'testing123', device_info: 'worktree-dev' }),
    })
    if (!loginResp.ok) {
      console.error(`[tauri-dev] Login failed (${loginResp.status}) — continuing without sync config`)
      return
    }
    const { token } = await loginResp.json()

    // .preferences.json lives in the notes dir (appdata_read/write use notes_root as base).
    const prefsPath = join(notesDir, '.preferences.json')
    const existing = existsSync(prefsPath) ? JSON.parse(readFileSync(prefsPath, 'utf8')) : {}
    writeFileSync(
      prefsPath,
      JSON.stringify(
        { ...existing, sync: { serverUrl: `http://localhost:${serverPort}`, token, lastSyncedAt: null, lastError: '' } },
        null,
        2
      ) + '\n'
    )
    console.log(`[tauri-dev] Server ready — http://localhost:${serverPort} | password: testing123`)
  }

  const configOverride = JSON.stringify({
    identifier,
    build: {
      beforeDevCommand: `npm run dev --prefix ../.. -- --host 127.0.0.1 --port ${vitePort} --strictPort`,
      devUrl: `http://127.0.0.1:${vitePort}`,
    },
  })

  console.log(`[tauri-dev] worktree slot ${slot} | vite port ${vitePort} | id ${identifier}`)
  console.log(`[tauri-dev] data dir: ${dataDir}`)

  // Wait for server + write preferences BEFORE spawning Tauri.
  // A cached binary starts in ~0.2s — fast enough to race the login. Awaiting here
  // ensures .preferences.json is on disk before the app's first readAppData call.
  await loginAndWritePrefs().catch((err) => console.error(`[tauri-dev] sync setup error: ${err.message}`))

  const tauri = spawn(
    'cargo',
    [
      'tauri', 'dev',
      '--config', 'src-tauri/tauri.dev.conf.json',
      '--config', configOverride,
    ],
    {
      cwd: join(repoRoot, 'apps/tauri'),
      env: {
        ...process.env,
        ...WAYLAND_ENV,
        STONEFRUIT_DATA_DIR: dataDir,
      },
      stdio: 'inherit',
    }
  )
  tauri.on('exit', (code) => process.exit(code ?? 0))
}
})().catch((err) => { console.error(err); process.exit(1) })
