// Gate red-proofs for the generated toolbar/title/bridge specs and Rust dependency boundaries; listed by ./proofs.mjs.
import { spawnSync } from 'node:child_process';

import {
  seed,
  TOOLBAR_SWIFT,
  TOOLBAR_KOTLIN,
  TITLE_SWIFT,
  TITLE_KOTLIN,
  BRIDGE_SWIFT,
  BRIDGE_KOTLIN,
} from './seed.mjs';

export const GENERATED_SPECS_PROOFS = [
  {
    gate: 'toolbar-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${TOOLBAR_SWIFT}`,
    claim: 'a generated native toolbar spec that drifts from the manifest must fail',
    inject: (wt) => seed.append(wt, TOOLBAR_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${TOOLBAR_SWIFT} is STALE`],
    absent: [`${TOOLBAR_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-toolbar-spec.ts --check stopped comparing rendered output against the file on disk — M8 (edit sources, not generated files) is unenforced for the toolbar contract.',
  },
  {
    gate: 'title-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${TITLE_SWIFT}`,
    claim: 'a generated native title spec that drifts from the manifest must fail',
    inject: (wt) => seed.append(wt, TITLE_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${TITLE_SWIFT} is STALE`],
    absent: [`${TITLE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-title-spec.ts --check stopped comparing rendered output against the file on disk.',
  },
  {
    gate: 'title-spec',
    id: 'manifest-changed-without-regenerating',
    seeded: 'changed MAX_TITLE_LENGTH in packages/editor/src/filename.ts without regenerating',
    claim: 'a manifest change that is not propagated to BOTH native specs must fail',
    inject: (wt) =>
      seed.replace(
        wt,
        'packages/editor/src/filename.ts',
        'export const MAX_TITLE_LENGTH = 200;',
        'export const MAX_TITLE_LENGTH = 201;',
      ),
    // Both hosts must be reported — a gate that only noticed one would leave
    // the other platform silently out of sync (M10).
    expect: [`${TITLE_SWIFT} is STALE`, `${TITLE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'the manifest → generated-spec direction is unguarded: a title-rule change can ship to one native host and not the other. Check the TARGETS loop in scripts/gen-title-spec.ts.',
  },
  {
    gate: 'title-spec',
    id: 'control-range-reaches-both-shells',
    seeded: 'expanded the canonical title-control range',
    claim: 'a canonical control-range change must regenerate both native title filters',
    inject: (wt) =>
      seed.replace(wt, 'packages/editor/src/filename.ts', '[0x007f, 0x009f],', '[0x007f, 0x00a0],'),
    expect: [`${TITLE_SWIFT} is STALE`, `${TITLE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'a native title filter no longer derives its control ranges from FORBIDDEN_TITLE_CONTROL_RANGES — check swiftControlRanges/kotlinRegexControlRanges in scripts/gen-title-spec.ts.',
  },
  {
    gate: 'bridge-spec',
    id: 'hand-edited-generated-file',
    seeded: `appended a line to ${BRIDGE_SWIFT}`,
    claim: 'a generated native bridge spec that drifts from bridge.ts must fail',
    inject: (wt) => seed.append(wt, BRIDGE_SWIFT, '\n// redproof sentinel hand edit\n'),
    expect: [`${BRIDGE_SWIFT} is STALE`],
    absent: [`${BRIDGE_KOTLIN} is STALE`],
    marker: 'claim',
    fix: 'scripts/gen-bridge-spec.ts --check stopped comparing rendered output against the file on disk — BRIDGE_VERSION and the outbound message list can drift from the native hosts.',
  },
  {
    gate: 'rust-dependency-boundaries',
    id: 'portable-crate-reaches-tantivy',
    seeded: 'added tantivy to crates/futo-notes-core/Cargo.toml (+ refreshed Cargo.lock offline)',
    claim: 'a portable core crate that reaches a search/ML dependency must fail',
    inject: (wt) => {
      seed.replace(
        wt,
        'crates/futo-notes-core/Cargo.toml',
        '[dependencies]\n',
        '[dependencies]\ntantivy = "0.26"\n',
      );
      // A real MR adding this dependency would also commit the lock update;
      // without it `cargo metadata --locked` dies before the gate's own logic
      // runs, which would be a crash, not a detection.
      const refresh = spawnSync('cargo', ['metadata', '--offline', '--format-version=1'], {
        cwd: wt,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      if (refresh.status !== 0) {
        throw new Error(
          `could not refresh Cargo.lock offline (is tantivy in the local cargo registry cache?):\n${refresh.stderr ?? refresh.error?.message ?? ''}`,
        );
      }
    },
    expect: ['futo-notes-core reaches tantivy'],
    fix: 'scripts/check-rust-dependency-boundaries.mjs stopped walking the resolve graph — the dep-guard that keeps tantivy/ort out of the portable crates (and out of the native FFI facade) is not enforcing anything.',
  },
];
