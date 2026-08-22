import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import {
  filterRows,
  formatSummaryLines,
  summarizeAccessibilityTree,
} from '../../../scripts/describe-ios-ui.mjs';
import { createAxeClient } from './axeClient.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_KEY_SETTLE_MS = 250;

function filesBelow(root, prefix = '') {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...filesBelow(path, relativePath));
    else files.push(relativePath);
  }
  return files.sort();
}

function claimedSimulatorOwner(name) {
  const ownerPath = join(homedir(), '.futo-notes-qa', 'devices', `ios-${name}.json`);
  if (!existsSync(ownerPath)) return null;
  try {
    return JSON.parse(readFileSync(ownerPath, 'utf8'));
  } catch {
    return null;
  }
}

export function createIosDevice({ udid = process.env.SIM } = {}) {
  const client = createAxeClient({ udid });
  const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

  async function waitFor(description, predicate, options = {}) {
    const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + limit;
    let lastError = null;

    for (;;) {
      try {
        const result = await predicate();
        if (result) return result;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) {
        const context = options.describeFailure ? `\n  ${await options.describeFailure()}` : '';
        const cause = lastError ? `\n  last read failed: ${lastError.message}` : '';
        throw new Error(`timed out after ${limit}ms waiting for ${description}${context}${cause}`);
      }
      await sleep(interval);
    }
  }

  function uiSummary() {
    return summarizeAccessibilityTree(client.describeUiTree());
  }

  const describeUi = () => formatSummaryLines(uiSummary()).join('\n');

  function exactLabel(label) {
    return (
      filterRows(uiSummary().rows, { labelContains: label, onScreenOnly: true }).find(
        (row) => row.label === label || row.id === label,
      ) ?? null
    );
  }

  const waitForLabel = (label, options = {}) =>
    waitFor(`"${label}" to appear`, () => exactLabel(label), {
      ...options,
      describeFailure: options.describeFailure ?? (() => `on screen:\n${describeUi()}`),
    });

  async function tapLabel(label, options = {}) {
    const row = await waitForLabel(label, options);
    if (!row.frame) throw new Error(`"${label}" has no tappable frame`);
    client.tapPoint(row.frame.x + row.frame.width / 2, row.frame.y + row.frame.height / 2);
    return row;
  }

  async function editorBodyRow({ belowY = 0 } = {}) {
    return waitFor(
      'the embedded editor body',
      () => {
        const rows = filterRows(uiSummary().rows, { onScreenOnly: true });
        const direct =
          rows.find((row) => row.type === 'TextArea' && row.frame) ??
          rows.find((row) => row.type === 'WebView' && row.frame);
        if (direct) return direct;

        // WKWebView's contenteditable is not always a named AX row. In that
        // shape AXe still exposes the editor's vertical scroll bar, whose y and
        // height are the body bounds and whose x is its trailing edge. Turn
        // that reported region into a tappable body frame; the Bold-toolbar
        // wait below proves the coordinate really focused the editor.
        const scrollBar = rows.find(
          (row) =>
            row.type === 'Slider' &&
            row.label?.startsWith('Vertical scroll bar') &&
            row.frame?.y >= belowY,
        );
        if (!scrollBar) return null;
        return {
          ...scrollBar,
          frame: {
            x: 0,
            y: scrollBar.frame.y,
            width: scrollBar.frame.x,
            height: scrollBar.frame.height,
          },
        };
      },
      { describeFailure: () => `on screen:\n${describeUi()}` },
    );
  }

  async function focusEditorBody() {
    const title = await waitFor(
      'the native title field',
      () =>
        filterRows(uiSummary().rows, { onScreenOnly: true }).find(
          (candidate) => candidate.type === 'TextField' && candidate.frame,
        ) ?? null,
      { describeFailure: () => `on screen:\n${describeUi()}` },
    );
    const row = await editorBodyRow({ belowY: title.frame.y + title.frame.height });
    const { frame } = row;

    // The embedded page makes the whole body tappable, including an empty note.
    // Stay near its leading/top padding so a non-empty future seed places the
    // caret in content rather than in trailing scroll space.
    const x = frame.x + Math.min(36, frame.width / 2);
    const y = frame.y + Math.min(36, frame.height / 2);
    // Prime the native keyboard, then observe its `done` control before
    // transferring focus into WKWebView. The body touch is dropped while the
    // title keyboard is still transitioning even though AXe reports success.
    client.tapPoint(title.frame.x + title.frame.width / 2, title.frame.y + title.frame.height / 2);
    await waitForLabel('done');
    // Headless CoreSimulator can construct the keyboard's AX subtree before
    // committing its final presentation. Capture only after `done` is visibly
    // on-screen; a frame taken while the keyboard is still animating leaves
    // AXe's later body touch reporting success while the title keeps focus.
    client.warmDisplay();

    // The native Markdown accessory exists only while the body owns focus, so
    // Bold remains the terminal condition rather than the touch exit code.
    let lastAttemptAt = 0;
    await waitFor(
      'the editor body to take focus',
      () => {
        const focused = exactLabel('Bold');
        if (focused) return focused;
        if (Date.now() - lastAttemptAt >= 1_000) {
          client.touchPoint(x, y);
          lastAttemptAt = Date.now();
        }
        return null;
      },
      { describeFailure: () => `on screen:\n${describeUi()}` },
    );
  }

  async function typeText(text, { keySettleMs = DEFAULT_KEY_SETTLE_MS } = {}) {
    for (let index = 0; index < text.length; index += 1) {
      client.typeText(text[index]);
      if (index + 1 < text.length) await sleep(keySettleMs);
    }
  }

  function vaultPath() {
    return join(client.appDataContainer(), 'Documents', 'fake-notes');
  }

  const vaultFiles = () => filesBelow(vaultPath());

  function resetVault() {
    client.terminate();
    const container = resolve(client.appDataContainer());
    const documents = resolve(container, 'Documents');
    const vault = resolve(documents, 'fake-notes');
    if (dirname(vault) !== documents || relative(container, vault).startsWith('..')) {
      throw new Error(`refusing to reset unexpected vault path: ${vault}`);
    }
    rmSync(vault, { recursive: true, force: true });
    mkdirSync(vault, { recursive: true });
    return vault;
  }

  function seedNote(filename, content) {
    if (basename(filename) !== filename || !filename.endsWith('.md')) {
      throw new Error(`seed filename must be one Markdown file, got: ${filename}`);
    }
    writeFileSync(join(vaultPath(), filename), content);
  }

  const readNote = (filename) => readFileSync(join(vaultPath(), filename), 'utf8');

  function requireReady() {
    if (process.platform !== 'darwin') {
      throw new Error('iOS device stories require macOS');
    }
    const simulator = client.simulator();
    if (!simulator) throw new Error(`SIM ${client.udid} is not an installed simulator`);
    if (simulator.state !== 'Booted') {
      throw new Error(`SIM ${client.udid} (${simulator.name}) is not booted`);
    }
    if (!simulator.name.startsWith('futo-qa-')) {
      throw new Error(
        `SIM ${client.udid} (${simulator.name}) is not a pooled QA simulator — run: just qa-claim ios`,
      );
    }

    const owner = claimedSimulatorOwner(simulator.name);
    const worktree = realpathSync(
      execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
    );
    if (!owner?.worktree || realpathSync(owner.worktree) !== worktree) {
      throw new Error(
        `SIM ${client.udid} (${simulator.name}) is not claimed by this worktree — run: just qa-claim ios`,
      );
    }

    // Resolving the container proves the exact debug app is installed. It also
    // pins all vault access below to com.futo.notes.dev rather than a release app.
    client.appDataContainer();
    client.requireTool();
  }

  return {
    client,
    waitFor,
    waitForLabel,
    tapLabel,
    focusEditorBody,
    typeText,
    vaultPath,
    vaultFiles,
    resetVault,
    seedNote,
    readNote,
    launch: client.launch,
    restartSimulator: client.restartSimulator,
    terminate: client.terminate,
    screenshot: client.screenshot,
    warmDisplay: client.warmDisplay,
    requireReady,
  };
}
