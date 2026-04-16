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

  // Sync server is now a separate repo (stonefruit-server).
  // Start it manually if you need sync: cd ~/Developer/stonefruit-server && PORT=3100 pnpm start
  // Then connect via: window.__testSync.connectE2ee('http://127.0.0.1:3100', 'dev@test.com', 'Dev', 'password')
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))

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
  // Server is external — no sync setup needed for dev

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
