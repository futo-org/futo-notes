// Optional Linux container runner; ordinary browser/CI coverage stays in the
// root config. The image has Node and browsers, so Vite needs no package manager.
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

const engine = process.env.FUTO_BROWSER_ENGINE ?? 'webkit';
const device = new Map([
  ['chromium', 'Desktop Chrome'],
  ['firefox', 'Desktop Firefox'],
  ['webkit', 'Desktop Safari'],
]).get(engine);
if (!device) throw new Error(`Unknown browser engine: ${engine}`);

export default defineConfig({
  ...base,
  projects: [{ name: engine, use: { ...devices[device] } }],
  webServer: { ...base.webServer, command: 'node node_modules/vite/bin/vite.js' },
});
