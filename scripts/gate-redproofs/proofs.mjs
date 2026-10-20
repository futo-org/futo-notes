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

import { BOUNDARIES_AND_DOCS_PROOFS } from './boundaries-and-docs.mjs';
import { THEME_AND_QA_INPUT_PROOFS } from './theme-and-qa-input.mjs';
import { GENERATED_SPECS_PROOFS } from './generated-specs.mjs';

export const PROOFS = [
  ...BOUNDARIES_AND_DOCS_PROOFS,
  ...THEME_AND_QA_INPUT_PROOFS,
  ...GENERATED_SPECS_PROOFS,
];
