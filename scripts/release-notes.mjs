#!/usr/bin/env node
// Print (or validate) the store release notes that the tag pipeline submits.
//
//   node scripts/release-notes.mjs --tag v1.7.2 --target ios    # whatsNew text
//   node scripts/release-notes.mjs --tag v1.7.2 --target play   # Play text
//   node scripts/release-notes.mjs --tag v1.7.2 --check         # gate one tag
//   node scripts/release-notes.mjs --all                        # gate every file
//
// `--check` is the tag gate (`check:release-notes`, wired into release:gate):
// it validates both targets and prints nothing on success. A tag that does not
// publish to the stores — anything but vX.Y.Z — passes trivially, so the gate
// can be a plain `needs` on every tag pipeline instead of an optional one.
//
// `--all` is the merge-request gate: it validates every file in release-notes/,
// so a malformed file is caught in review rather than on the tag, where the
// only fix is a re-tag.
//
// Format and limits: scripts/lib/release-notes.mjs.

import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  STABLE_TAG_PATTERN,
  parseReleaseNotes,
  releaseNotesPath,
  validateReleaseNotes,
} from './lib/release-notes.mjs';

const NOTES_DIR = 'release-notes';

function parseArgs(argv) {
  const args = { tag: process.env.CI_COMMIT_TAG || '', target: null, check: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') args.check = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--tag') args.tag = argv[++i] ?? '';
    else if (arg === '--target') args.target = argv[++i] ?? '';
    else if (arg.startsWith('--tag=')) args.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--target=')) args.target = arg.slice('--target='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// Validate every committed release-notes file. Used by the MR gate.
function checkAll() {
  let files;
  try {
    files = readdirSync(NOTES_DIR)
      .filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name))
      .sort();
  } catch {
    die(`Missing ${NOTES_DIR}/ — see ${NOTES_DIR}/README.md.`);
    return;
  }

  const problems = files.flatMap((name) => {
    const tag = name.replace(/\.md$/, '');
    return validateReleaseNotes(parseReleaseNotes(readFileSync(`${NOTES_DIR}/${name}`, 'utf8')), {
      tag,
    });
  });

  if (problems.length > 0) die(problems.join('\n'));
  process.stdout.write(`${files.length} release-notes file(s) validate.\n`);
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    die(String(error.message));
    return;
  }

  if (args.all) {
    checkAll();
    return;
  }

  if (!args.tag) {
    die('No tag: pass --tag v1.2.3, --all, or set CI_COMMIT_TAG.');
    return;
  }

  if (!STABLE_TAG_PATTERN.test(args.tag)) {
    // Only stable tags reach the stores, so only they need notes. Passing here
    // (rather than failing) lets the gate run on every tag pipeline.
    if (args.check) {
      process.stdout.write(
        `${args.tag} is not a stable release tag — no store release notes needed.\n`,
      );
      return;
    }
    die(`"${args.tag}" is not a stable release tag (vX.Y.Z), so it publishes to no store.`);
    return;
  }

  if (!args.check && !['ios', 'play'].includes(args.target)) {
    die('Pass --target ios|play, or --check to validate both.');
    return;
  }

  const path = releaseNotesPath(args.tag);
  let source;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    die(
      `Missing ${path}.\n` +
        `Every stable tag needs store release notes — see ${NOTES_DIR}/README.md.\n` +
        `They must exist ON the tagged commit, so write the file in the release MR; ` +
        `committing them afterwards means re-tagging.`,
    );
    return;
  }

  const notes = parseReleaseNotes(source);
  const problems = validateReleaseNotes(notes, { tag: args.tag });
  if (problems.length > 0) {
    die(problems.join('\n'));
    return;
  }

  if (args.check) {
    process.stdout.write(
      `${path}: App Store ${notes.appStore.length} chars, Google Play ${notes.play.length} chars — OK.\n`,
    );
    return;
  }
  process.stdout.write(args.target === 'ios' ? notes.appStore : notes.play);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
