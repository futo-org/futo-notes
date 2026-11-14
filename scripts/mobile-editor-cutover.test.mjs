// Mobile must ship one native renderer. Keep desktop Milkdown and its standalone test bundle.
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
      /import WebKit|import android\.webkit\.(WebView|JavascriptInterface)|TextFirstFlag|class EditorHost|FutoEditor\.initialize/.test(
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

  it('neither builds nor stages the web bundle for mobile', () => {
    for (const file of [
      'just/mobile.justfile',
      'just/android-test.justfile',
      'apps/android/run.sh',
      'apps/ios/run.sh',
      'apps/ios/run-device.sh',
      'apps/ios/deploy.sh',
      'ci/android.yml',
      'ci/cirrus/ios-build.yml',
      'ci/cirrus/ios-test.yml',
    ]) {
      expect(read(file), file).not.toMatch(/vite build --config vite\.editor\.config\.ts/);
    }
    expect(read('vite.editor.config.ts')).not.toMatch(/apps\/(ios|android)/);
    expect(read('apps/ios/project.yml')).toContain('- editor.html');
    expect(read('apps/android/app/build.gradle.kts')).toContain(
      'ignoreAssetsPattern += ":editor.html"',
    );
  });

  it('preserves the desktop web editor and its standalone bundle', () => {
    expect(read('vite.editor.config.ts')).toContain('viteSingleFile()');
    expect(read('vite.editor.config.ts')).toContain("'editor.html'");
    expect(fs.existsSync(path.join(root, 'src/features/editor/milkdown'))).toBe(true);
    expect(read('package.json')).toContain('test:e2e:editor-embed');
  });
});
