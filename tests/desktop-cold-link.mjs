#!/usr/bin/env node
// `just test-desktop-cold-link` verifies a link arriving before the webview exists.
// The dev supervisor stops Vite when its child exits: restarting a raw dev binary
// can leave a dead URL. This Linux recipe refuses an occupied worktree Vite port
// and builds current sources with `just build-desktop-test` (custom-protocol),
// loading tauri://localhost without Vite. Requires a working desktop session.
// Fixed fixture: futonotes://license/not-a-license/not-an-activation; no URL args,
// real key or account. Checks the catalog invalid-link toast, drained inbox and
// unlicensed state, then a clean restart. A running-app bridge tests another lifecycle.
// App data, notes and Linux registration files are isolated in a new
// verification-runs/desktop-cold-link-* directory. The launcher verifies qa-target
// identity before connecting; logs, binary identity, rendered/restart state and
// owned data are retained. Stops only its children; does not prove native pixels
// or other platforms' URL delivery. startDesktopTauriInstance accepts literal args;
// restarting without args drops the link while reusing the isolated data directories.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { portsFor } from '../scripts/lib/slot.mjs';
import {
  startDesktopTauriInstance,
  restartDesktopTauriInstance,
  assertRunPath,
} from './lib/tauri-instance.mjs';
import { executeJs } from './lib/mcp-client.mjs';

export async function assertViteStopped(port) {
  await Promise.all(
    ['127.0.0.1', '::1'].map(
      (host) =>
        new Promise((resolve, reject) => {
          const socket = net.connect({ host, port });
          socket.once('connect', () => {
            socket.destroy();
            reject(
              new Error(`Vite port ${port} is occupied; stop this worktree's dev session first`),
            );
          });
          socket.once('error', (error) => {
            socket.destroy();
            if (['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(error.code)) resolve();
            else reject(error);
          });
          socket.setTimeout(1000, () => {
            socket.destroy();
            reject(new Error(`Cannot establish whether Vite port ${port} is stopped`));
          });
        }),
    ),
  );
}

export async function runColdLinkProof(root) {
  const parent = path.join(root, 'verification-runs');
  assertRunPath(parent, root);
  fs.mkdirSync(parent, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(parent, 'desktop-cold-link-'));
  assertRunPath(runDir, parent);
  const env = {
    XDG_DATA_HOME: path.join(runDir, 'xdg-data'),
    XDG_CONFIG_HOME: path.join(runDir, 'xdg-config'),
    GDK_BACKEND: 'wayland',
    WINIT_UNIX_BACKEND: 'wayland',
  };
  for (const dir of [env.XDG_DATA_HOME, env.XDG_CONFIG_HOME]) fs.mkdirSync(dir);
  const languages = path.join(root, 'languages');
  const invalidToasts = new Set(
    fs
      .readdirSync(languages)
      .filter((file) => file.endsWith('.json') && file !== 'catalog.schema.json')
      .map(
        (file) =>
          JSON.parse(fs.readFileSync(path.join(languages, file))).messages?.license?.linkInvalid,
      )
      .filter((message) => typeof message === 'string'),
  );
  const previousEvidenceDir = process.env.FUTO_VERIFICATION_DIR;
  process.env.FUTO_VERIFICATION_DIR = runDir;
  let client;
  try {
    client = await startDesktopTauriInstance('cold invalid link', root, {
      args: ['futonotes://license/not-a-license/not-an-activation'],
      env,
    });
    const started = Date.now();
    let rendered;
    while (Date.now() - started < 15000) {
      rendered = JSON.parse(
        await executeJs(
          client.ws,
          `JSON.stringify({
        href: location.href, shell: !!document.querySelector('.notes-shell'),
        state: window.__notesShellTest.getState(), toast: document.querySelector('.toast')?.textContent,
        rect: (() => { const r = document.querySelector('.toast')?.getBoundingClientRect();
          return r ? { width: r.width, height: r.height } : null; })(),
      })`,
        ),
      );
      if (invalidToasts.has(rendered.toast)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (
      !rendered.shell ||
      !invalidToasts.has(rendered.toast) ||
      !rendered.rect?.width ||
      !rendered.rect?.height
    )
      throw new Error(`Invalid cold link did not render its outcome: ${JSON.stringify(rendered)}`);
    if (new URL(rendered.href).protocol !== 'tauri:')
      throw new Error(`Expected embedded frontend, got ${rendered.href}`);
    const pending = await executeJs(
      client.ws,
      'await window.__TAURI__.core.invoke("license_take_pending_link")',
    );
    const license = await executeJs(
      client.ws,
      'await window.__TAURI__.core.invoke("license_status")',
    );
    if (pending !== null || license.state !== 'unlicensed' || license.key !== null)
      throw new Error('Invalid fixture was not drained without installing a license');
    fs.writeFileSync(
      path.join(runDir, 'cold.json'),
      JSON.stringify({ rendered, pending, license }, null, 2),
    );
    await restartDesktopTauriInstance(client, root, { env });
    const after = JSON.parse(
      await executeJs(
        client.ws,
        'JSON.stringify({shell:!!document.querySelector(".notes-shell"),state:window.__notesShellTest.getState()})',
      ),
    );
    if (!after.shell || after.state.toastMessage)
      throw new Error('Link outcome replayed on a launch without a link');
    fs.writeFileSync(path.join(runDir, 'restart.json'), JSON.stringify(after, null, 2));
    console.log(
      `PASS: embedded frontend, invalid cold link rendered and drained once, no replay. Evidence: ${runDir}`,
    );
  } finally {
    if (previousEvidenceDir === undefined) delete process.env.FUTO_VERIFICATION_DIR;
    else process.env.FUTO_VERIFICATION_DIR = previousEvidenceDir;
    if (client) {
      const proc = client.proc;
      client.stop();
      if (proc.exitCode === null && proc.signalCode === null)
        await new Promise((resolve) => {
          const timer = setTimeout(() => proc.kill('SIGKILL'), 15000);
          proc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
    }
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 1 || args[0] !== '--preflight'))
      throw new Error(
        'Usage: just test-desktop-cold-link (fixed invalid fixture; no URL arguments)',
      );
    if (process.platform !== 'linux')
      throw new Error('This CLI cold-link fixture currently requires Linux');
    const root = fs.realpathSync(fileURLToPath(new URL('..', import.meta.url)));
    await assertViteStopped(portsFor(root).tauriVite);
    if (!args.length) await runColdLinkProof(root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
