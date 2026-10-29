# Editor recovery is part of the local note engine's write workflow

Decided 2026-10-29: build editor recovery together with store integration. A killed app may
lose only the edit in flight. Device crash or power loss is a separate guarantee: preserve
every edit covered by a successful durable flush, with an initial durability-window target
of 100 ms to validate on devices. The target is not a measured result. Storage failure must
surface failure and preserve recoverable work; a failed flush never counts as durable.

Recovery and outside writes must obey ADR-0001's persist-or-park promise. A sync update or
restore between an app crash and reopening a note must neither resurrect intentionally
replaced text nor silently discard a recoverable draft. Recovery must participate in the
local note engine's coordinated write workflow; no caller may be responsible for remembering
an independent log-cleanup sequence. The detailed recovery transaction belongs in the
implementation spec. The edit-in-flight allowance covers the edit currently being applied,
not a growing queue of already displayed edits waiting for a transport timer. A desktop
WebAssembly edit returning is not evidence that the backend accepted its recovery record.

If recovery storage cannot accept another edit, pause accepting new edits, retain the current
draft as copyable text and show the failure. Do not silently continue with RAM-only edits.
A failed markdown checkpoint alone need not pause input while the recovery log remains
healthy; the existing failed-save and leave rules still apply. Resume accepting edits only
when recoverability is restored, without marking a failed write as saved.

Use focused, deterministic regression and fault-injection checks as each behavior is built.
Bootcamp is a risk-prioritized source of drills, not an accepted blanket graduation gate:
large nightly campaigns, exhaustive enumeration and mutation testing are deferred until the
work can be divided up. Known content-loss or recovery failures block acceptance of the
behavior they affect.

Implementation contract: [GitLab issue #283](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283).
