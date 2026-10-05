import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { slotOf } from '../lib/slot.mjs';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function claimTauriSlot(
  root,
  stateDir = path.join(os.homedir(), '.futo-notes-qa', 'slots'),
) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, `s${slotOf(root)}.json`);
  const record = {
    worktree: path.resolve(root),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new Error(`Tauri slot ownership is unreadable at ${file}; inspect it before retrying`);
    }
    if (Number.isInteger(owner.pid) && isAlive(owner.pid)) {
      throw new Error(
        `worktree slot ${slotOf(root)} is in use by ${owner.worktree} (pid ${owner.pid})`,
      );
    }
    throw new Error(
      `worktree slot ${slotOf(root)} has a stale lease at ${file} (last pid ${owner.pid ?? 'unknown'}); ` +
        'verify that process is gone, then remove this lease file before retrying',
    );
  }

  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid === process.pid && current.worktree === record.worktree) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // Leave unreadable ownership for manual inspection rather than removing
      // a lease that may have been replaced by another process.
    }
  };
}
