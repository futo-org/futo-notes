import { mount } from 'svelte';
import { installGlobalHandlers } from '$features/system/crashHandler';
import { prefetchLocalNoteListing } from '$lib/localNoteStore';
import { localizedText } from '$shared/localization';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();
prefetchLocalNoteListing();

if (import.meta.env.DEV) {
  document.title = localizedText('app.desktop.debugDisplayName');
}

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
