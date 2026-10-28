// Puppet verb coverage gate (docs/research/agent-native-app-design.md, "Controls name their verbs").
// Everything a user can do in the shared UI must be a verb `futo-puppet` can
// `do`, and the manifest only stays complete if the gap is caught where it
// opens: the component that owns a handler. Deny-by-default:
//
//   node scripts/check-puppet-verbs.mjs   (just check-puppet-verbs)
//
// Fails on:
//   (a) a `src/**` TypeScript module that wires its own DOM listener
//       (`addEventListener('click', …)`, `el.onclick = …`, a window keydown shortcut
//       table) and builds no verb (`registerPuppetVerbs(`, or `puppetVerb(`) and is not
//       in scripts/puppet-verbs-allowlist.json. A Svelte component's handlers are its
//       controls, held to verbs one by one by the per-control half below.
//   (a2) an `apps/ios/Sources/**` SwiftUI view with a control (a `Button`, a
//       `Toggle`, a swipe action, a context menu, a text field…) that never calls
//       `.puppetVerbs {` (apps/ios/Sources/App/PuppetVerbs.swift) and is not
//       allowlisted. A phone's chrome is native, so without this the driver's
//       reach stops at the webview — measured on 2026-09-22, when `drive` could
//       not rename, find or move from the editor screen at all. A `Link(` is out
//       of scope: it hands the act to the OS, and the app does nothing.
//   (a3) an `apps/android/app/src/main/**` Compose file with a control (an
//       `onClick =`, a `.clickable`, an `onValueChange =`…) that never calls
//       `PuppetVerbScope {` (apps/android/app/src/main/java/com/futo/notes/puppet/PuppetVerb.kt)
//       and is not allowlisted. Same reason as (a2): the title field had no verb, so
//       a driver renamed a note with `adb shell input` taps (2026-09-23).
//   (b) a stale allowlist entry: the file is gone, has no handlers any more, or
//       now registers verbs itself
//
// This half is per file: a file with six handlers and one verb passes it. The
// per-control half (checkPuppetControls, below) closes that for every Svelte, SwiftUI
// and Compose control labelled with a catalog key: each verb names its controls' label keys
// (`controls`), and a labelled control no verb claims fails. Its ceilings: a claim
// is per label key across a platform, so two "Cancel" buttons are claimed together,
// and a control whose label is computed is only counted per file. Its exceptions,
// each with the reason, are in scripts/puppet-controls-allowlist/<platform>.json. This file's
// allowlist is for handlers another file's verbs cover, or presentation-only ones
// (stopPropagation, focus trapping), with the reason next to the path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  catalogKeys,
  DOM_EVENTS,
  KOTLIN_HANDLER,
  maskCode,
  nativeControlTable,
  nativeControls,
  svelteControls,
  SWIFT_CONTROL,
  verbDeclarations,
} from './lib/puppet-controls.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
// The inspector itself: its listeners record the app, they are not the app.
const EXEMPT_DIRS = ['src/app/puppet'];

// A control that wires its own listener — a CodeMirror widget, a floating toolbar, a panel
// built in TypeScript. The rendered task checkbox lived here for months with no verb, because
// a gate that only reads Svelte `onclick=` attributes cannot see a `toDOM()` that calls
// addEventListener itself.
const WIRED_LISTENER = new RegExp(
  `addEventListener\\(\\s*['"](?:${DOM_EVENTS})['"]|\\.on(?:${DOM_EVENTS})\\s*=(?!=)`,
  'g',
);
const REGISTERS = /\b(?:registerPuppetVerbs|puppetVerb)\(/;

// SwiftUI's controls and the gestures a view takes a touch with, and the modifier a screen
// registers its own verbs with.
const SWIFT_HANDLER = new RegExp(
  `${SWIFT_CONTROL.source}|\\.(?:onTapGesture|swipeActions|contextMenu|onSubmit|onLongPressGesture)\\b`,
  'g',
);
const SWIFT_REGISTERS = /\.puppetVerbs\s*(?:\([^)]*\)\s*)?\{/;

// The scope a Compose screen registers its own verbs in.
const KOTLIN_REGISTERS = /\bPuppetVerbScope\s*(?:\([^)]*\)\s*)?\{/;
const KOTLIN_ROOT = 'apps/android/app/src/main/java';
// The listener and the registry are the machinery, not the app.
const MACHINERY = /^apps\/ios\/Sources\/App\/Puppet|\/com\/futo\/notes\/puppet\//;

function walk(dir, extensions, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__mocks__' || entry.name === 'Generated') continue;
      walk(full, extensions, out);
    } else if (extensions.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every file the gate reads, on every platform. The inspector and generated code are left
 * out; the listeners and the registry are machinery: their verbs count, their controls and
 * handlers are not the app's.
 */
function scanned(root) {
  return Object.entries(PLATFORMS).flatMap(([platform, where]) =>
    where.dirs
      .flatMap((dir) => walk(path.join(root, dir), where.files))
      .flatMap((file) => {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (EXEMPT_DIRS.some((dir) => relative.startsWith(`${dir}/`))) return [];
        if (relative.includes('/uniffi/')) return [];
        const source = fs.readFileSync(file, 'utf8');
        return [{ platform, file, relative, machinery: MACHINERY.test(relative), source }];
      }),
  );
}

// Handlers are read from the source as written (an event name is a string); a registration
// only counts in code, not in a comment or a string.
function handlersIn(file, source) {
  const code = maskCode(source);
  if (file.endsWith('.swift')) {
    return {
      handlers: [...source.matchAll(SWIFT_HANDLER)].map((m) => m[0].trim()),
      registers: SWIFT_REGISTERS.test(code),
    };
  }
  if (file.endsWith('.kt')) {
    // `import androidx.compose.foundation.clickable` names the modifier without using it.
    const imported = source.replace(/^import .*$/gm, '');
    return {
      handlers: [...imported.matchAll(KOTLIN_HANDLER)].map((m) => m[0].replace(/\s*=$/, '')),
      registers: KOTLIN_REGISTERS.test(code),
    };
  }
  return {
    handlers: [...source.matchAll(WIRED_LISTENER)].map((m) => m[0]),
    registers: REGISTERS.test(code),
  };
}

export function checkPuppetVerbs({ root = ROOT, allowlist } = {}) {
  const allowed =
    allowlist ??
    JSON.parse(fs.readFileSync(path.join(root, 'scripts/puppet-verbs-allowlist.json'), 'utf8'));
  const failures = [];
  const seen = new Set();
  for (const { file, relative, machinery, source } of scanned(root)) {
    if (machinery || file.endsWith('.svelte')) continue;
    const { handlers, registers } = handlersIn(file, source);
    if (handlers.length === 0) continue;
    seen.add(relative);
    if (registers) {
      if (relative in allowed) {
        failures.push(`${relative}: registers verbs now — drop its allowlist entry`);
      }
      continue;
    }
    if (relative in allowed) continue;
    failures.push(
      `${relative}: ${handlers.length} handler${handlers.length === 1 ? '' : 's'} (${[
        ...new Set(handlers),
      ].join(', ')}) and no ${
        file.endsWith('.swift')
          ? '.puppetVerbs {'
          : file.endsWith('.kt')
            ? 'PuppetVerbScope {'
            : 'registerPuppetVerbs('
      } — add the verbs beside the handlers, or an allowlist entry with the reason`,
    );
  }
  for (const entry of Object.keys(allowed)) {
    if (!fs.existsSync(path.join(root, entry))) {
      failures.push(`${entry}: allowlisted but the file is gone`);
    } else if (!seen.has(entry)) {
      failures.push(`${entry}: allowlisted but has no handlers any more`);
    }
  }
  return failures;
}

/** The controls allowlist: one `<platform>.json` per PLATFORMS key, read as one; a missing one is empty. */
function readControlsAllowlist(root) {
  const allowed = { computed: {}, noControl: {}, unclaimed: {} };
  for (const platform of Object.keys(PLATFORMS)) {
    const file = path.join(root, 'scripts/puppet-controls-allowlist', `${platform}.json`);
    if (!fs.existsSync(file)) continue;
    const part = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const section of Object.keys(allowed)) Object.assign(allowed[section], part[section]);
  }
  return allowed;
}

/**
 * Where each platform's controls and verbs live. A listener's own verbs are in its
 * `nativeControls` table; its file is machinery, not a screen, so its controls are not read.
 */
const PLATFORMS = {
  desktop: { language: 'ts', dirs: ['src'], files: /\.(svelte|ts)$/, tables: [] },
  ios: {
    language: 'swift',
    dirs: ['apps/ios/Sources'],
    files: /\.swift$/,
    tables: ['apps/ios/Sources/App/PuppetServerContract+NativeVerbs.swift'],
  },
  android: {
    language: 'kotlin',
    dirs: [KOTLIN_ROOT],
    files: /\.kt$/,
    tables: ['apps/android/app/src/debug/java/com/futo/notes/puppet/PuppetContract.kt'],
  },
};

/**
 * The per-control half of the gate. Every verb names the catalog keys of its controls'
 * labels (`controls`), so, read from source, without running anything:
 *   (c) a verb's key must be in the catalog, take no arguments (the app shows the verb on
 *       every row reading that label) and label a control on its platform;
 *   (d) a control labelled with a catalog key must be claimed by some verb on its platform;
 *   (e) a verb that is not a convenience must name a control;
 *   (f) a control whose label is computed is counted per file against the allowlist;
 *   (g) allowlist entries must still be true.
 * The allowlist (scripts/puppet-controls-allowlist/<platform>.json) says why for each exception: a
 * verb with no labelled control (a note row), a labelled control no verb stands for (a
 * confirmation's Cancel), a file's controls whose labels are computed.
 */
export function checkPuppetControls({ root = ROOT, allowlist } = {}) {
  const allowed = allowlist ?? readControlsAllowlist(root);
  const catalog = catalogKeys(root);
  const failures = [];
  const usedNoControl = new Set();
  const usedUnclaimed = new Set();
  const seenComputed = new Set();
  const files = scanned(root);
  for (const [platform, where] of Object.entries(PLATFORMS)) {
    const verbs = [];
    const controls = [];
    for (const scan of files.filter((scan) => scan.platform === platform)) {
      const { file, relative, machinery, source } = scan;
      for (const verb of verbDeclarations(source, where.language))
        verbs.push({ ...verb, file: relative });
      if (machinery) continue;
      const found = file.endsWith('.svelte')
        ? svelteControls(source)
        : where.language === 'ts'
          ? []
          : nativeControls(source, where.language);
      const computed = found.filter((control) => control.keys.length === 0).length;
      const listed = allowed.computed?.[relative];
      if (listed) seenComputed.add(relative);
      if (computed > 0 && listed?.count !== computed) {
        failures.push(
          listed
            ? `${relative}: ${computed} control(s) with a computed label, the allowlist says ${listed.count} — update the count, or label the new one with a catalog key a verb claims`
            : `${relative}: ${computed} control(s) with a computed label that no check can hold to a verb — label it with a catalog key, or add a computed entry with the reason`,
        );
      } else if (computed === 0 && listed) {
        failures.push(`${relative}: allowlisted for computed labels but has none any more`);
      }
      for (const control of found) controls.push({ ...control, file: relative });
    }
    for (const table of where.tables) {
      const file = path.join(root, table);
      if (!fs.existsSync(file)) {
        // A platform this gate scans with no table would drop every native verb and pass.
        if (where.dirs.some((dir) => fs.existsSync(path.join(root, dir))))
          failures.push(
            `${table}: the listener table of native verbs is missing — point tables at the file that holds nativeControls`,
          );
        continue;
      }
      for (const verb of nativeControlTable(fs.readFileSync(file, 'utf8')))
        verbs.push({ ...verb, file: table });
    }
    const labels = new Set(controls.flatMap((control) => control.keys));
    const claimed = new Set(verbs.flatMap((verb) => verb.controls));
    for (const verb of verbs) {
      const id = `${platform}:${verb.name}`;
      if (verb.controls.length === 0) {
        if (verb.convenience) continue;
        if (id in (allowed.noControl ?? {})) {
          usedNoControl.add(id);
          continue;
        }
        failures.push(
          `${verb.file}:${verb.line}: ${verb.name} names no control — add the catalog key of the label of the control it stands for (controls), or a noControl entry "${id}" with the reason`,
        );
        continue;
      }
      for (const key of verb.controls) {
        if (!catalog.has(key)) {
          failures.push(
            `${verb.file}:${verb.line}: ${verb.name} claims "${key}", which is not in languages/en.json`,
          );
        } else if (catalog.get(key).templated) {
          failures.push(
            `${verb.file}:${verb.line}: ${verb.name} claims "${key}", a label with arguments that reads differently on every row, so no row can be matched to it on screen — list the control under unclaimed with the verb that does it`,
          );
        } else if (!labels.has(key)) {
          failures.push(
            `${verb.file}:${verb.line}: ${verb.name} claims "${key}", but no control on ${platform} is labelled with it`,
          );
        }
      }
    }
    for (const control of controls) {
      if (control.keys.length === 0 || control.keys.some((key) => claimed.has(key))) continue;
      const exempt = control.keys
        .map((key) => `${platform}:${key}`)
        .find((id) => id in (allowed.unclaimed ?? {}));
      if (exempt) {
        usedUnclaimed.add(exempt);
        continue;
      }
      failures.push(
        `${control.file}:${control.line}: a control labelled ${control.keys.map((key) => `"${key}"`).join(' / ')} that no verb claims — add the key to the controls of the verb that does what it does, or an unclaimed entry with the reason`,
      );
    }
  }
  for (const id of Object.keys(allowed.noControl ?? {})) {
    if (!usedNoControl.has(id))
      failures.push(`noControl "${id}": no such verb without a control any more`);
  }
  for (const id of Object.keys(allowed.unclaimed ?? {})) {
    if (!usedUnclaimed.has(id))
      failures.push(`unclaimed "${id}": no unclaimed control has that label any more`);
  }
  for (const file of Object.keys(allowed.computed ?? {})) {
    if (!seenComputed.has(file))
      failures.push(`computed "${file}": the file is gone or was not scanned`);
  }
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = [...checkPuppetVerbs(), ...checkPuppetControls()];
  if (failures.length > 0) {
    console.error(`check-puppet-verbs: ${failures.length} problem(s)\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      '\nEvery user-triggerable handler needs a verb (src/app/puppet/puppetRegistry.ts, registerPuppetVerbs).',
    );
    process.exit(1);
  }
  console.log(`check-puppet-verbs: OK (${SRC}, apps/ios/Sources, ${KOTLIN_ROOT})`);
}
