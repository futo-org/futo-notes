// Command reachability gate (architecture-hardening.md PKT-7 gate 1 / F24 /
// L2-4). Every Tauri command registered in application.rs's
// generate_handler![...] should have an invoke() caller somewhere in src/, or
// be explicitly allowlisted (scripts/command-reachability-allowlist.json)
// with a reason. Also catches the inverse: invoke() of a name that isn't
// registered at all (typo, or a command renamed/removed on the Rust side
// without updating the TS caller).
//
//   node scripts/check-command-reachability.mjs   (just check-command-reachability)
//
// Fails on:
//   (a) a registered command with no caller, not allowlisted
//   (b) an allowlisted command that NOW has a caller (stale allowlist entry)
//   (c) invoke('name') where 'name' isn't a registered command at all
//   (d) an allowlist entry for a command that no longer exists in Rust

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLICATION_RS = path.join(ROOT, 'apps/tauri/src-tauri/src/application.rs');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts/command-reachability-allowlist.json');
const SRC_DIR = path.join(ROOT, 'src');

function readRegisteredCommands() {
  const text = fs.readFileSync(APPLICATION_RS, 'utf8');
  const block = text.match(/generate_handler!\s*\[([\s\S]*?)\]/);
  if (!block) {
    throw new Error(
      `could not find generate_handler![...] in ${path.relative(ROOT, APPLICATION_RS)}`,
    );
  }
  const names = [...block[1].matchAll(/crate::[a-zA-Z0-9_:]+::([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
  if (names.length === 0) {
    throw new Error('parsed zero commands out of generate_handler![...] — did the syntax change?');
  }
  return names;
}

function walk(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

// Matches invoke('name', ...) / invoke<T>('name', ...), tolerating a
// multi-line generic type argument (e.g. `invoke<Array<{ ... }>>(\n  'x',`).
const INVOKE_RE = /invoke\s*(?:<[\s\S]*?>)?\s*\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g;

// Strips `// ...` and `/* ... */` comments so a commented-out invoke() call
// doesn't count as a live caller (a registered command whose only remaining
// reference was commented out must still fail as unreachable). Tracks
// string/template-literal state so `//` inside a string (e.g. a URL) isn't
// mistaken for a line comment; doesn't parse `${...}` interpolation inside
// template literals, which is fine here since we only care whether a
// `//`/`/*` falls inside quotes.
function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      i--; // let the loop's i++ land back on the newline
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++; // i now on the '/'; loop's i++ moves past it
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < text.length) {
          out += text[i] + text[i + 1];
          i++;
        } else {
          out += text[i];
        }
        i++;
      }
      out += text[i] ?? '';
      continue;
    }
    out += c;
  }
  return out;
}

function readInvokedNames() {
  const files = walk(SRC_DIR, ['.ts', '.svelte']).filter(
    (f) => !f.endsWith('.test.ts') && !f.split(path.sep).includes('__mocks__'),
  );
  const invoked = new Map(); // command name -> [relative file paths]
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of text.matchAll(INVOKE_RE)) {
      const name = match[1];
      const rel = path.relative(ROOT, file);
      if (!invoked.has(name)) invoked.set(name, []);
      if (!invoked.get(name).includes(rel)) invoked.get(name).push(rel);
    }
  }
  return invoked;
}

const registered = readRegisteredCommands();
const registeredSet = new Set(registered);
const invoked = readInvokedNames();
const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
const allowlistNames = Object.keys(allowlist).filter((k) => k !== '_comment');

const failures = [];

for (const name of registered) {
  const callers = invoked.get(name);
  const allowlisted = allowlistNames.includes(name);
  if (!callers && !allowlisted) {
    failures.push(
      `registered command '${name}' has no invoke() caller in src/ and is not in the allowlist ` +
        `(${path.relative(ROOT, ALLOWLIST_PATH)}) — wire it up, or add it with a reason.`,
    );
  }
  if (callers && allowlisted) {
    failures.push(
      `allowlisted command '${name}' now has caller(s) (${callers.join(', ')}) — remove it from ` +
        `the allowlist, the entry is stale.`,
    );
  }
}

for (const [name, files] of invoked) {
  if (!registeredSet.has(name)) {
    failures.push(
      `invoke('${name}') in ${files.join(', ')} does not match any command registered in ` +
        `${path.relative(ROOT, APPLICATION_RS)} — typo, or a command renamed/removed on the Rust side?`,
    );
  }
}

for (const name of allowlistNames) {
  if (!registeredSet.has(name)) {
    failures.push(
      `allowlist entry '${name}' does not match any currently-registered command — remove it ` +
        `(the command was deleted) or fix the typo.`,
    );
  }
}

if (failures.length > 0) {
  console.error('Command reachability gate FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(`\n${failures.length} issue(s).`);
  process.exit(1);
}

console.log(
  `Command reachability gate OK — ${registered.length} registered commands, ` +
    `${allowlistNames.length} allowlisted as intentionally dead.`,
);
