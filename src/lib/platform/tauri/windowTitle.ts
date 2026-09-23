import { getCurrentWindow } from '@tauri-apps/api/window';

// The native title has two writers that change independently: App.svelte sets
// the localized app name (re-run on every language change) and TabsStrip sets
// the active note. Each updates only its own half and re-applies the whole, so
// neither can erase the other's.
let appName = import.meta.env.DEV ? 'FUTO Notes (Dev)' : 'FUTO Notes';
let noteTitle: string | undefined;

export async function applyApplicationWindowTitle(title: string): Promise<void> {
  appName = title;
  await applyWindowTitle();
}

export async function applyAppWindowTitle(title?: string): Promise<void> {
  noteTitle = title;
  await applyWindowTitle();
}

async function applyWindowTitle(): Promise<void> {
  await getCurrentWindow().setTitle(noteTitle ? `${noteTitle} — ${appName}` : appName);
}
