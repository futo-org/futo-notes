import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const vaultDir = path.resolve(process.env.STONEFRUIT_DEMO_VAULT ?? path.join(home, 'Documents', 'demo-vault'));
const backupDir = path.resolve(process.env.STONEFRUIT_DEMO_VAULT_BACKUP ?? path.join(home, 'Documents', 'demo-vault-backup'));
const serverUrl = (process.env.STONEFRUIT_SERVER_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const nukeUrl = `${serverUrl}/dev/nuke`;
const setupUrl = `${serverUrl}/setup`;
const resetPassword = process.env.STONEFRUIT_RESET_PASSWORD ?? 'testing123';

function assertSafePath(targetPath, expectedName) {
  if (path.basename(targetPath) !== expectedName) {
    throw new Error(`Refusing to operate on unexpected path: ${targetPath}`);
  }
}

async function ensureDirectory(targetPath, label) {
  const stat = await fs.stat(targetPath).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`${label} does not exist: ${targetPath}`);
  }
}

async function emptyDirectory(targetPath) {
  const entries = await fs.readdir(targetPath);
  await Promise.all(entries.map((entry) => fs.rm(path.join(targetPath, entry), { recursive: true, force: true })));
}


async function resetServer() {
  const res = await fetch(nukeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ confirmation: 'DELETE' }),
  }).catch((error) => {
    throw new Error(`Failed to reach server at ${nukeUrl}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    throw new Error(`Server reset failed (${res.status}): ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}

async function setupServerPassword() {
  const res = await fetch(setupUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: resetPassword }),
  }).catch((error) => {
    throw new Error(`Failed to reach server setup endpoint at ${setupUrl}: ${error instanceof Error ? error.message : String(error)}`);
  });

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!res.ok) {
    throw new Error(`Server setup failed (${res.status}): ${typeof payload === 'string' ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}


async function main() {
  assertSafePath(vaultDir, 'demo-vault');
  assertSafePath(backupDir, 'demo-vault-backup');
  await ensureDirectory(backupDir, 'Backup directory');
  await fs.mkdir(vaultDir, { recursive: true });

  console.log(`Resetting server via ${nukeUrl}`);
  const serverResult = await resetServer();
  console.log(`Server reset complete: ${JSON.stringify(serverResult)}`);
  console.log(`Setting default password via ${setupUrl}`);
  const setupResult = await setupServerPassword();
  console.log(`Server setup complete: ${JSON.stringify(setupResult)}`);

  console.log(`Clearing ${vaultDir}`);
  await fs.rm(vaultDir, { recursive: true, force: true });
  await fs.mkdir(vaultDir, { recursive: true });

  console.log(`Restoring ${backupDir} -> ${vaultDir}`);
  const entries = await fs.readdir(backupDir);
  let restored = 0;
  for (const entry of entries) {
    await fs.cp(path.join(backupDir, entry), path.join(vaultDir, entry), {
      recursive: true,
      force: true,
      preserveTimestamps: true,
    });
    restored++;
  }
  console.log(`Restored ${restored} entries to ${vaultDir}`);

  console.log(`Reset complete. Password: ${resetPassword}`);
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
