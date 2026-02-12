import { mount } from 'svelte';
import { installGlobalHandlers } from '$lib/crashHandler';
import App from './App.svelte';
import './styles/app.css';

installGlobalHandlers();

const app = mount(App, {
  target: document.getElementById('app')!
});

export default app;
