#!/usr/bin/env node
// Real desktop editor → save → process restart → editor + disk readback.
// Synthetic vault only; bridge input does not establish physical keyboard/IME behavior.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopTauriInstance } from './lib/tauri-instance.mjs';
import { executeJs } from './lib/mcp-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
let client;
let reportDir;

async function stopClient() {
  if (!client || client.proc.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.proc.kill('SIGKILL');
      reject(new Error('app did not exit within 10s'));
    }, 10000);
    client.proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    client.stop();
  });
}

async function restart() {
  const storage = client.storage;
  await stopClient();
  client = await startDesktopTauriInstance('journeys', root, { storage });
}

async function typeText(text) {
  const inserted = await executeJs(
    client.ws,
    `(() => {
    const editor = document.querySelector('.cm-content');
    if (!editor) throw new Error('editor content is absent');
    editor.focus();
    return document.execCommand('insertText', false, ${JSON.stringify(text)});
  })()`,
  );
  assert.equal(inserted, true, 'WebView accepted insertText');
}

async function savedBody(id, expected) {
  await client.flushSave();
  assert.equal(await client.readNote(id), expected);
  assert.equal(fs.readFileSync(path.join(client.notesDir, `${id}.md`), 'utf8'), expected);
}

async function journey(name, fn) {
  const startedAt = new Date().toISOString();
  try {
    await fn();
    results.push({ name, status: 'PASS', startedAt });
  } catch (error) {
    results.push({ name, status: 'FAIL', startedAt, error: error.message });
    throw error;
  } finally {
    try {
      const snapshot = await executeJs(
        client.ws,
        `({ userAgent: navigator.userAgent, text: document.body.innerText, editor: window.__notesShellTest.getState() })`,
      );
      fs.writeFileSync(
        path.join(reportDir, `journey-${results.length}-state.json`),
        JSON.stringify(snapshot, null, 2),
      );
    } catch (error) {
      console.error(`State capture unavailable: ${error.message}`);
    }
    fs.writeFileSync(
      path.join(reportDir, 'journeys.json'),
      JSON.stringify(
        {
          fixture: 'desktop-persistence-v1',
          input:
            'WebView insertText for creation, existing replaceEditorContent hook for replacement, title input for renaming; no OS input',
          results,
        },
        null,
        2,
      ),
    );
  }
}

async function main() {
  client = await startDesktopTauriInstance('journeys', root);
  reportDir = process.env.FUTO_VERIFICATION_DIR || client.storage.instanceDir;
  await journey('create, edit, relaunch and reopen the saved note', async () => {
    await client.openNewNote();
    await client.setTitle('Journey note');
    await typeText('A durable first line.');
    await savedBody('Journey note', 'A durable first line.');
    await restart();
    await client.openNote('Journey note');
    assert.equal((await client.getOpenNoteState()).editorContent, 'A durable first line.');
    await executeJs(
      client.ws,
      `window.__notesShellTest.replaceEditorContent('The edited body survives restart.')`,
    );
    await savedBody('Journey note', 'The edited body survives restart.');
    await restart();
    await client.openNote('Journey note');
    assert.equal(
      (await client.getOpenNoteState()).editorContent,
      'The edited body survives restart.',
    );
  });
  await journey('rename through the title field and retain backlinks after relaunch', async () => {
    await client.openNewNote();
    await client.setTitle('Journey reference');
    await typeText('Read [[Journey note]] next.');
    await savedBody('Journey reference', 'Read [[Journey note]] next.');
    await client.openNote('Journey note');
    await client.setTitle('Renamed journey');
    await savedBody('Renamed journey', 'The edited body survives restart.');
    await restart();
    await client.openNote('Journey reference');
    assert.equal((await client.getOpenNoteState()).editorContent, 'Read [[Renamed journey]] next.');
    assert.equal(fs.existsSync(path.join(client.notesDir, 'Journey note.md')), false);
    assert.equal(
      fs.readFileSync(path.join(client.notesDir, 'Journey reference.md'), 'utf8'),
      'Read [[Renamed journey]] next.',
    );
  });
  assert.equal(results.length, 2);
  console.log(`Desktop journeys: ${results.length}/2 PASS; evidence: ${reportDir}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopClient();
}
