// ---------------------------------------------------------------------------
// The proof registry
//
// Each entry:
//   gate        key into GATES
//   id          stable name, `gate/id` is what the report prints
//   seeded      one line describing the injected violation (shown on failure)
//   claim       the gate's own promise this proof is testing
//   inject(wt)  perform the injection
//   expect      substrings the gate output MUST contain (string[] or (wt) => string[]);
//               computed BEFORE injection so a proof can key off the pristine baseline
//   absent      substrings the output must NOT contain — discrimination, so a
//               gate that fails everything can't pass as a working gate
//   marker      omit for the strong kind — a token this proof invented and the
//               gate echoed back. Set 'claim' where the gate reports staleness
//               without echoing any content, so the assertion has to be the
//               gate's own failure sentence; the report labels those so a reader
//               can see which proofs are the weaker kind. Either way it still
//               separates "detected" from "crashed", which is the line that matters.
//   fix         remediation printed when the proof fails
// ---------------------------------------------------------------------------

import { seed } from './seed.mjs';
import { BOUNDARIES_AND_DOCS_PROOFS } from './boundaries-and-docs.mjs';
import { THEME_AND_QA_INPUT_PROOFS } from './theme-and-qa-input.mjs';
import { GENERATED_SPECS_PROOFS } from './generated-specs.mjs';

export const PROOFS = [
  {
    gate: 'workflow-syntax',
    id: 'invalid-async-workflow-body',
    seeded: 'invalid declaration in a workflow body that has valid metadata and top-level return',
    claim: 'workflow syntax must fail without executing the body',
    inject: (wt) =>
      seed.append(
        wt,
        '.claude/workflows/bugfix-pipeline.js',
        '\nconst __workflow_redproof__ = ;\n',
      ),
    expect: [
      '.claude/workflows/bugfix-pipeline.js',
      '__workflow_redproof__',
      'Expression expected',
    ],
    fix: 'repair the named workflow declaration; do not run the workflow to check syntax',
  },
  {
    gate: 'node-modules',
    id: 'stale-installed-lock',
    seeded: 'changed pnpm-lock.yaml without updating the installed snapshot',
    claim: 'source lockfile must match the installed dependency snapshot',
    inject: (wt) => seed.append(wt, 'pnpm-lock.yaml', '\n# redproof stale snapshot\n'),
    expect: ['installed dependency snapshot differs', 'pnpm-lock.yaml'],
    marker: 'claim',
    fix: 'run pnpm install --frozen-lockfile before checking the changed dependency tree',
  },
  ...BOUNDARIES_AND_DOCS_PROOFS,
  ...THEME_AND_QA_INPUT_PROOFS,
  ...GENERATED_SPECS_PROOFS,
];
