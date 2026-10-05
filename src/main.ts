import { mount } from 'svelte';
import { installGlobalHandlers } from '$features/system/crashHandler';
import { prefetchLocalNoteListing } from '$lib/localNoteStore';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();
prefetchLocalNoteListing();

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
