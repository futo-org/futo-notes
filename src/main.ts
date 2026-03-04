import { mount } from 'svelte';
import { installGlobalHandlers } from '$lib/crashHandler';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();

if (import.meta.env.DEV) {
  document.title = 'Stonefruit (dev)';
}

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
