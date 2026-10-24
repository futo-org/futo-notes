// Dev-server-only fixture: mount the shipping component with web platform
// stubs, without pretending the whole app is running inside Tauri.
import { mount } from 'svelte';
import '../../../src/styles/app.css';
import DesktopChromePreview from './DesktopChromePreview.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('Desktop chrome fixture has no mount target');
mount(DesktopChromePreview, { target });
