import { mount } from 'svelte';
import { installGlobalHandlers } from '$features/system/crashHandler';
import { prefetchLocalNoteListing } from '$lib/localNoteStore';
import { readPersistedNoteSortOrder } from '$features/notes/noteSortOrder';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();
prefetchLocalNoteListing(readPersistedNoteSortOrder());

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
