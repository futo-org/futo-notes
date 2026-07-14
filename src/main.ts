import { mount } from 'svelte';
import { installGlobalHandlers } from '$features/system/crashHandler';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();

if (import.meta.env.DEV) {
  document.title = 'FUTO Notes (dev)';
}

const app = mount(App, {
  target: document.getElementById('app')!,
});

export default app;
