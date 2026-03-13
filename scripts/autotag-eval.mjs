/**
 * Autotagger evaluation script.
 * Resets the server, imports a representative sample of demo-vault notes,
 * configures + runs the autotagger, then displays results for evaluation.
 *
 * Usage: node scripts/autotag-eval.mjs
 *   FULL=1 node scripts/autotag-eval.mjs   — run on all notes
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const vaultDir = path.join(home, 'Documents', 'demo-vault');
const serverUrl = 'http://localhost:3005';
const password = 'testing123';

// Representative sample: ~20 notes spanning all 3 categories + edge cases
const SAMPLE_NOTES = [
  // Clear futo
  'FUTO Chat Pitch 1.md',
  'Stonefruit Smart Transforms Next.md',
  'FUTOpay Grayjay Integration.md',
  'Building Crash Reporting.md',           // futo work, but title says "building"
  'Building the Self-hosted Server.md',    // futo work, title says "building"
  'Hacker News pitch.md',                  // pitching FUTO Notes
  // Clear personal
  'Jokes and bits.md',
  'dates about jane.md',
  'Pot Roast Recipe.md',
  '2025-02-20.md',                         // journal entry
  'The 100 Best Movies of the 2000s.md',
  'Brussels Planning.md',                  // travel
  'Next few months.md',                    // life planning
  'The Cold Email Handbook.md',            // article
  // Clear project-ideas
  'Startup Business Ideas.md',
  'Side Project - Spending Analyzer.md',
  'AI Chatbot for Colleges.md',
  'Project Comet.md',
  // Edge cases
  'Software Coding Project Ideas.md',     // has existing #ideas tag → should skip
  'words that shouldn\'t be spelled that way.md',  // random personal
  'High Agency.md',                        // self-improvement → personal
  'This week (3-9-2026 to 3-14).md',      // weekly tasks
  '2 week ML Sprint.md',                  // could be futo or project-ideas
];

function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function uuid() {
  return crypto.randomUUID();
}

async function api(method, endpoint, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${serverUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok && res.status !== 409) {
    throw new Error(`${method} ${endpoint} failed (${res.status}): ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function resetAndSetup() {
  console.log('Resetting server...');
  await api('POST', '/dev/nuke', null, { confirmation: 'DELETE' });
  await api('POST', '/setup', null, { password });
  const { token } = await api('POST', '/login', null, { password, device_info: 'autotag-eval' });
  console.log('Server reset + auth done.');
  return token;
}

async function importNotes(token) {
  const full = process.env.FULL === '1';
  let files;
  if (full) {
    files = (await fs.readdir(vaultDir)).filter(f => f.endsWith('.md'));
  } else {
    // Use sample, but verify they exist
    files = [];
    for (const f of SAMPLE_NOTES) {
      try {
        await fs.access(path.join(vaultDir, f));
        files.push(f);
      } catch {
        console.warn(`  WARN: sample note not found: ${f}`);
      }
    }
  }
  console.log(`Importing ${files.length} notes${full ? ' (FULL)' : ' (sample)'}...`);

  const notes = [];
  for (const file of files) {
    const content = await fs.readFile(path.join(vaultDir, file), 'utf8');
    notes.push({
      uuid: uuid(),
      filename: file,
      content_hash: contentHash(content),
      hash_at_last_sync: '',
      content,
      modified_at: Date.now(),
    });
  }

  const batchSize = 50;
  for (let i = 0; i < notes.length; i += batchSize) {
    const batch = notes.slice(i, i + batchSize);
    await api('POST', '/sync', token, {
      notes: batch,
      all_uuids: notes.map(n => n.uuid),
      deleted_uuids: [],
    });
  }
  console.log(`Imported ${notes.length} notes.`);
  return notes.length;
}

async function configureAndRun(token) {
  const full = process.env.FULL === '1';
  await api('POST', '/plugins/auto-tagger/config', token, {
    auto_apply: true,
    schedule_kind: 'manual',
    config: {
      maxNotesToScan: full ? 250 : 30,
      staleMinutes: 1,
    },
  });
  await api('POST', '/plugins/auto-tagger/enable', token);

  console.log('Running autotagger...');
  const { run_id } = await api('POST', '/plugins/auto-tagger/run', token);

  const start = Date.now();
  while (Date.now() - start < 600_000) {
    const data = await api('GET', `/plugins/runs/${run_id}`, token);
    const status = data.run?.status;
    if (['succeeded', 'failed', 'cancelled'].includes(status)) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Run ${status} in ${elapsed}s.`);
      return data;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Run timed out');
}

function displayResults(data) {
  const items = data.items || [];
  const run = data.run || {};
  const summary = run.summary || {};

  const byTag = {};
  for (const item of items) {
    const preview = item.preview || {};
    const after = item.after || {};
    const tags = after.tagsToAdd || preview.proposedTags || [];
    const title = preview.noteTitle || '?';
    for (const tag of tags) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(title);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`RESULTS: ${items.length} tagged / ${summary.notesScanned ?? '?'} scanned`);
  console.log(`${'='.repeat(60)}`);

  for (const [tag, notes] of Object.entries(byTag).sort()) {
    console.log(`\n#${tag} (${notes.length}):`);
    for (const n of notes.sort()) console.log(`  ${n}`);
  }

  console.log(`\n${'='.repeat(60)}\n`);
}

async function main() {
  const token = await resetAndSetup();
  await importNotes(token);
  const data = await configureAndRun(token);
  displayResults(data);
}

await main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
