<script lang="ts">
  import { Capacitor } from '@capacitor/core';
  import { StatusBar, Style } from '@capacitor/status-bar';
  import NotesShell from './components/NotesShell.svelte';
  import { initNotes } from '$lib/notes';

  // State
  let hash = $state(window.location.hash.slice(1) || '/');
  let initialized = $state(false);
  let error: string | null = $state(null);

  // Derived: extract note ID from hash
  const noteId = $derived.by(() => {
    // '/' or '' -> null
    if (hash === '/' || hash === '') return null;

    // '/note/:id' pattern
    const match = hash.match(/^\/note\/(.+)$/);
    if (match) {
      const id = match[1];
      // '/note/new' -> 'new'
      // '/note/:id' -> decodeURIComponent(id)
      return id === 'new' ? 'new' : decodeURIComponent(id);
    }

    // Unknown route
    return null;
  });

  // Initialize app on mount
  $effect(() => {
    // Hash change listener
    function onHashChange(): void {
      hash = window.location.hash.slice(1) || '/';
    }
    window.addEventListener('hashchange', onHashChange);

    // Initialize app
    async function init(): Promise<void> {
      try {
        if (Capacitor.isNativePlatform()) {
          await initNotes();
          await StatusBar.setStyle({ style: Style.Light });
          await StatusBar.setBackgroundColor({ color: '#ffffff' });
        }
        initialized = true;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    init();

    // Cleanup
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  });
</script>

{#if error}
  <div style="padding: 20px; font-family: system-ui;">
    <h1>Init Error</h1>
    <pre style="white-space: pre-wrap; background: #f0f0f0; padding: 10px; border-radius: 8px;">{error}</pre>
  </div>
{:else if initialized}
  <NotesShell {noteId} />
{:else}
  <!-- Loading state - could add spinner if desired -->
{/if}
