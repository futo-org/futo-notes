# Captured UIKit input

Full Japanese/Korean JSON captures are preserved byte-for-byte in the external
evidence; English responses are exported from complete Puppet trace receipts.
Repository copies split metadata and ordered event groups to meet the file-token
gate, preserving every original native JSON value. These are actual callback
lists, never generated input shapes. Captured on owned pooled iOS simulator iOS 27.2
(24B114), through actual keyboard/candidate touches with `just puppet`.

`native-input-cases.json` is the hand-reviewed replay contract. Event IDs identify actual
callbacks in each raw capture. Its literal source expectations are independent
of the source diff algorithm. The source's `__` delimiters and CRLF remain
exact. The captures opened `&amp;`, which the editor no longer decodes, so the cases
write it `&`: every recorded display, range and keyboard result is unchanged, and the
raw captures (`sourceUTF16`) keep the original bytes; default backward affinity at the bold end retains inserted CJK
inside the existing bold run. No event is renamed to `setMarkedText`: Japanese
storage updates arrived through `didChange`; Korean updates arrived through
`didChange` nested inside `insertText`, after UIKit had removed the prior syllable.
Replay consumes the resultant text-service state once, never both outer and nested
callbacks, or the physical Jamo request as an appended character.

A `marked` step draws the public engine composition over a display-only reference
view without accepting source. A `commit` step is the `didChange` inside actual
`unmarkText`; nested selection notifications cannot add another source edit.
Korean `replace` steps map the actual stable native results to hand-reviewed
`serviceRange`/`serviceText` footprints in the public OS replacement operation.
Each footprint must independently reconstruct the captured full native result.
This accounts for UIKit removing the previous syllable before insertText without
inventing a replace callback. English correction uses its actual proposed range
and replacement. Returned caret positions are checked directly against native
UTF-16 selections, including exact Undo/Redo; no selection echo masks a wrong
delta. Each delta goes through the reference view. The engine chooses source runs.

Capture source: Japanese conversion recorder native source was byte-identical to
932ff07ed; Japanese reconversion and Korean to 052d2c216. Engine build was
418fe675e4cbda6d20b4548dd6421bdca88fe404. Replay head is separate from capture
head. These are plain-control OS evidence, not evidence that a shipping renderer
already uses the portable engine.

Original full receipts, keyplane/candidate JSON, screenshots, registered keyboard
provenance, build/source hashes and preferences restoration are retained at
`/tmp/futo-editor-283-evidence/294-os` and the durable handoff bundle
`/Users/justin/Developer/futo-notes/editor-283-handoff-20261029-1950/evidence/294-os`.
`captureSha256` pins the original full capture; `fixtureSha256` pins every
repository fragment checked by the WASM consumer. The conservation report in
external evidence confirms that reconstructing the groups preserves every
original JSON value and event order. The old first-English capture predates delegate recording and is excluded. The
fresh English capture on the newly claimed iOS0 uses the same 052d2c216 recorder
source with engine integration b06a29477; correction is actual top-level
shouldChangeText/didChange between insertText callbacks. Ordinary letters use
the typing seam; the correction uses the text-service seam. Its history literals
retain carried bold formatting across the initial space and keep correction and
following space separate. Dictation placeholders have not been captured and must
not be inferred from literal U+FFFC.

The fifth capture is a software-keyboard suggestion: actual key touches produced
`helo`; the system candidate row offered `help` at {{134,546},{134,44}}, and an
actual touch at (201,568) selected it. UIKit recorded shouldChangeText [3,7] →
`help`, a subsequent inserted space, then native selection [8,9] followed by
`deleteBackward` whose actual result removed both adjacent spaces. Replay keeps
that smart cleanup's full observed footprint [7,9] and final `ab help& cd`,
rather than pretending UIKit deleted only its selected space. `undoSelection`
records the real selection change between the preceding action and cleanup.

These software-key touches exposed an existing AXe gesture problem: the native
input was delivered, but Puppet's following screen read could refuse after AXe
switched ApplicationAccessibilityEnabled off. Preserve those refused receipts;
never call them successful receipts. The complete native trace, actual offered
candidate frame, and resulting text independently establish delivery. The
sanctioned read-only system-elements wrapper preserves the preference; ordinary
taps currently require restoring this claimed simulator's known build baseline
before another read. Counterprobes and pc_a707ed20d7db are in the external evidence.
`Dictate` was present and enabled in that keyplane, but was never tapped: a deliberate
fixture-audio/consent setup is still needed, so no dictation OS proof is claimed.

The sixth capture is whole-field OS Paste in the same ordinary UIKit control.
Actual Copy from a separate fixture placed `the & cat\r\n` on this task simulator's
clipboard. After opening source `__teh__ &amp; **cta**\r\n` (`&` in the case) and selecting its complete
display `[0,11]`, an actual touch selected the offered Paste item at
`{{172.5,112},{70.33333333333331,44}}`. UIKit's event4 `shouldChangeText` proposes
that entire range and replacement; event5 changes selection before event6
`didChange`, so `requestEvent` pins the actual request rather than assuming
adjacent callbacks. No public `replace` override occurred. Literal replay retains
the unchanged `&`, both original bold delimiter spellings, CRLF and final
newline, with exact one-action history and final caret `[11,11]`. This establishes
OS Paste only; it does not establish dictation or Writing Tools.

Whole-field capture used the preserved 2026-10-29 15:39 DEBUG simulator app from
the previous native297-test run, executable SHA256
`867392656ed8b07a3eae919844e6b11a782951b4ea947a21959a6a7a7829d6b8`.
Recorder source remains `fb307d2c3a0174ba27f69437ad7cfadf4454d91c6b36cac63cfdef9c9078d304`.
It was lifecycle-installed on newly claimed iOS0 and launched with Puppet at
source integration `c424d2cb4`; this is precise capture provenance, not a new
native-test result. Original raw capture, complete Puppet trace, menu accessibility
and conservation report are external `whole-field-paste-*` artifacts.
