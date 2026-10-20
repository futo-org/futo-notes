## 1. The requirement (the contract every approach is scored against)

Three tiers, in order of severity. These are the fixed pass/fail criteria.

1. **Never refuse.** Every markdown file opens editable. No modal, no blocked
   save, no whole-note "source-mode only" degradation.
2. **Never warn.** No user-facing message in any wording that means "your
   markdown is formatted weird" — no banners, no per-note error states, no
   recovery-draft flows triggered by ordinary editing.
3. **Diff discipline.** Saving after an edit changes only the bytes the user
   actually touched. Untouched content is byte-exact, including whitespace,
   escapes, marker style (`__` vs `**`, `1)` vs `1.`), and LF/CRLF. Silently
   re-spelling an _edited_ block (autolink → inline link, table re-padding,
   list-marker normalization) is a **soft violation**: the user finds out
   later via git diff or sync churn, which is the same insult delivered
   quietly. The measured TipTap branch does this on 18.94% of edits — that
   number is the anti-goal.

Tier 1 and 2 violations are hard kills. Tier 3 is scored (percentage of edits
whose diff exceeds the touched region); the bar is ~0% for the common-construct
set, with any residue enumerated and justified per construct.
