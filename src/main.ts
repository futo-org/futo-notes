import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';
import { router } from './router';
import { initNotes } from './lib/notes';
import { renderNotesShell } from './screens/NotesShell';
import './styles/index.css';

async function init() {
  const app = document.getElementById('app');
  try {
    // Only init native features on native platforms
    if (Capacitor.isNativePlatform()) {
      await initNotes();
      await StatusBar.setStyle({ style: Style.Light });
      await StatusBar.setBackgroundColor({ color: '#ffffff' });
    }

    router.register('/', () => renderNotesShell({}));
    router.register('/note/:id', (params) => renderNotesShell(params as { id: string }));
    router.start();
  } catch (error) {
    console.error('App initialization failed:', error);
    if (app) {
      app.innerHTML = `<div style="padding: 20px; font-family: system-ui;">
        <h1>Init Error</h1>
        <pre style="white-space: pre-wrap; background: #f0f0f0; padding: 10px; border-radius: 8px;">${error}</pre>
      </div>`;
    }
  }
}

init();
