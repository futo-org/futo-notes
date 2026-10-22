## 5. What the transcripts show: reads after actions

Over the 87 action→read pairs there were 91 distinct reads. Each read is classified by what the
agent used next, as its following text shows.

| read after an action | count | what Claude wanted | carried by the lean result? |
|---|---|---|---|
| `doc` after Undo/Type/Press/Insert/Replace/AppendLine/BulletList/Redo/CreateNote/OpenNote | 52 | the document as it now reads. Docs were tiny: median 22 chars, p90 46, max 395 | **yes**: changed lines, or all of them (≤12) when a doc opens |
| `state` after SetFindQuery/OpenFind (9), CreateNote (3), Type/Press/PlaceCaret (4), click (3), drive (1) | 20 | find query/total/current, selection, caret, focus, screen | **yes**: header (caret/sel/focus/screen) plus `find.*` paths |
| `actions` after OpenFind (3), OpenSettings (1), a 404 (1) | 5 | the verbs that just appeared, or the verbs that exist | **yes**: `verbs +…`, and `here:` on a 404 |
| `elements`/`find` after clicking the language button | 2 | "is the dropdown open?" | **yes**: `overlay ±listbox` (needs sibling b) |
| `actions` after CreateNote/PlaceCaret/Replace/Undo | 6 | first-time verb discovery ("There's a dedicated `Undo` verb") | no; this is a legitimate one-off `actions` |
| `find`/`elements` for rects (04 wrapped-row) | 3 | geometry for a click | no; that is what `find` is for |
| `events` after drive | 2 | the event sequence | no; that is trace (sibling a) |
| `doc` after `doc` | 1 | — | — |

**79 of 91 (87%) follow-up reads would have been unnecessary.** Each chained read cost about
0.6 s of tool time. Each separate read cost a whole model turn, about 4.7 s of thinking (audit).
None of the 12 remaining reads asked for state the result should have carried.

---
