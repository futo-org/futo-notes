import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { router } from './router';
import { initDB } from './lib/db';
import { ensureNotesDir } from './lib/fileSystem';
import { renderNotesList } from './screens/NotesList';
import { renderNoteEditor } from './screens/NoteEditor';
import './styles/index.css';

async function init() {
  try {
    // Only init native features on native platforms
    if (Capacitor.isNativePlatform()) {
      await initDB();
      await ensureNotesDir();
      await StatusBar.setStyle({ style: Style.Light });
      await StatusBar.setBackgroundColor({ color: '#ffffff' });
    }

    router.register('/', () => renderNotesList());
    router.register('/note/:id', (params) => renderNoteEditor(params as { id: string }));
    router.start();
  } catch (error) {
    console.error('App initialization failed:', error);
  }
}

init();
