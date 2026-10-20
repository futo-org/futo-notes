## 8. QA stories (`docs/qa/`)

Update `wikilink-pop-large-edited-note.md`: the "why a person" paragraph is now wrong (the
`change` names its note); keep the story, rewrite the rationale as "UIKit's adopt-before-exit
order is the one thing nothing below the navigation stack reproduces", re-run, record.

Add two stories, each with the result of the run on this branch and what it could not prove:

- `background-while-streaming.md` (iOS and Android): open a 20k-section note, type a word in
  the first section while "Loading the rest" shows, background the app within a second,
  wait, kill the app, reopen: the word is in the file. Covers RC-92 without the read.
- `exit-from-a-stuck-page.md` (Android first, iOS if the Mac is available): the 50,000-line
  single-paragraph note from 2026-09-01 (`docs/plan/milkdown-transition.md` §5); open it, press
  Back during the parse: the user leaves at once (not behind → proceed on `latest`), the file
  is unchanged, and the next note opens correctly once the parse ends. Then: type into a small
  note, switch to the giant one, press Back during ITS parse — the small note's word is in its
  file (the switch flushed it tagged).
