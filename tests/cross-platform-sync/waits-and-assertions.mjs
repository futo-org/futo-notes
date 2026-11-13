/**
 * Assertions and condition-polling waits shared by every desktop scenario.
 */

import { sleep } from '../lib/mcp-client.mjs';

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export async function waitForOpenNoteTitle(client, expectedTitle, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.title === expectedTitle) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: title did not become ${JSON.stringify(expectedTitle)} after ${timeoutMs}ms`,
  );
}

export async function waitForEditorContent(client, expectedContent, timeoutMs = 10_000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    last = state.editorContent;
    if (state.editorContent === expectedContent) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: editor content did not become ${JSON.stringify(expectedContent)} after ${timeoutMs}ms ` +
      `(last seen: ${JSON.stringify(last)})`,
  );
}

/**
 * Wait until the open note has no save pending — the settled, durable state.
 *
 * Deliberately one-directional: polling for savePending === TRUE races the app,
 * because a debounce window (500ms body / a blur flush's in-flight save) can
 * open and close between two bridge round trips. A scenario that needs to
 * observe an UNSAVED note must control the ordering instead of racing for it
 * (see client.composeNoteAndSyncNow), and one that just needs the edit on disk
 * should flushSave() and wait here.
 */
export async function waitForSaveIdle(client, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (state.savePending === false) return state;
    await sleep(50);
  }
  throw new Error(`${client.name}: savePending did not become false after ${timeoutMs}ms`);
}

/**
 * Wait for the open-note session itself to satisfy [predicate].
 *
 * Never on toast copy. This used to wait for the exact string 'Note was deleted
 * during sync'; the app's wording was later shortened to 'Note was deleted' and
 * the scenario then failed for the one reason it was not testing, while the
 * behavior it WAS testing (the session closing) had worked all along — which is
 * why a cross-platform test must not assert user-facing strings (AGENTS.md M15).
 */
export async function waitForOpenNoteState(client, description, predicate, timeoutMs = 10_000) {
  const start = Date.now();
  let state;
  while (Date.now() - start < timeoutMs) {
    state = await client.getOpenNoteState();
    if (predicate(state)) return state;
    await sleep(100);
  }
  throw new Error(
    `${client.name}: open note did not ${description} after ${timeoutMs}ms ` +
      `(state=${JSON.stringify(state)})`,
  );
}

export async function waitForToastClear(client, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await client.getOpenNoteState();
    if (!state.toastMessage) return state;
    await sleep(100);
  }
  throw new Error(`${client.name}: toast did not clear after ${timeoutMs}ms`);
}

export async function externalWriteNote(client, id, content) {
  await client.externalWriteNote(id, content);
}

/** Poll the sidebar for a note title, waiting up to timeoutMs. */
export async function waitForNoteInSidebar(client, titleSubstring, timeoutMs = 5_000) {
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += 500) {
    await sleep(500);
    const items = await client.readWebview(
      `[...document.querySelectorAll('.note-row, [data-note-id]')].map(el => (el.getAttribute('data-note-id') || el.textContent.trim()))`,
      'sidebar note list',
    );
    if (items.some((t) => t.includes(titleSubstring))) return;
  }
  throw new Error(`"${titleSubstring}" not found in ${client.name}'s sidebar after ${timeoutMs}ms`);
}

/** Get all note titles currently visible in the sidebar. */
export async function getSidebarTitles(client) {
  return client.readWebview(
    `[...document.querySelectorAll('.note-row, [data-note-id]')].map(el => (el.getAttribute('data-note-id') || el.textContent.trim()))`,
    'sidebar note list',
  );
}
