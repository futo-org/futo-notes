// Mobile must ship one native renderer, with no web editor host.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(file) : [file];
  });
}

describe('mobile Linedown cutover', () => {
  it('has no mobile web editor host or renderer-selection switch', () => {
    const sources = [
      ...files('apps/ios/Sources').filter((file) => !file.includes('/Generated/')),
      ...files('apps/ios/Tests'),
      ...files('apps/ios/UITests'),
      ...files('apps/android/app/src').filter((file) => !file.includes('/uniffi/')),
    ].filter((file) => /\.(swift|kt)$/.test(file));
    const offenders = sources.filter((file) =>
      /import WebKit|import android\.webkit\.(WebView|JavascriptInterface)|TextFirstFlag|class EditorHost|FutoEditor\.initialize|EditorDraftCoordinator|PendingEditorDraft|publishDraft|setDraftProvider|setDraftFlushWaiter|setEditorFlushWaiter/.test(
        read(file),
      ),
    );
    expect(offenders).toEqual([]);
    expect(read('apps/ios/Sources/Notes/List/NoteListView.swift')).toContain(
      'TextFirstNoteScreen(',
    );
    expect(read('apps/android/app/src/main/java/com/futo/notes/MainActivityShell.kt')).toContain(
      'TextFirstEditorScreen(',
    );
  });

  // Warm checkouts still hold the retired editor.html bundle (gitignored); neither app may
  // package it.
  it('never packages a stale web editor bundle', () => {
    expect(read('apps/ios/project.yml')).toContain('- editor.html');
    expect(read('apps/android/app/build.gradle.kts')).toContain(
      'ignoreAssetsPattern += ":editor.html"',
    );
  });
});
