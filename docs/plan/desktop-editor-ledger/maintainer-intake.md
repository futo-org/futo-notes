# Maintainer intake, 2026-11-10

All 32 original reports map to ledger rows below. Repeated symptoms share a rule rather than multiplying the count. A prior complaint, a suspected mechanism and a proven fix are deliberately distinguished. `055240f3b` is on `android-text-first`, not main or this desktop branch.

1. Poor performance on selecting & toolbar tasks on larger note which leads to extremely weird behavior that takes a long time (up to 2 minutes, might just be broken?) and stacks up and is unresponsive (can't do anything in the note, can't leave the note)
   - [PF04](large-notes-and-performance.md#pf04). Same report in 055240f3b §E; Android handler queue identified, latency root still requires attribution.

2. Poor typing performance in large quote block
   - [PF03](large-notes-and-performance.md#pf03). Same report in 055240f3b §E; canonical explicit quotes now have local work bounds, while lazy/nested quote regions still need measurement.

3. Can't deselect options on the toolbar (header)
   - [HG04](headings.md#hg04). Explicit 3A in 055240f3b; active heading toggle now specified.

4. Not able to add bold, italics or strikethrough on a selected header; could earlier; longer note; allowed to switch header level
   - [IF01](inline-formats.md#if01). A2 in 055240f3b; formatting acceptance and rendering are separate, do not assume one fix.

5. When selecting a menu item, the number isn't highlighted, and the bold / italics / highlights don't show as selected on the toolbar (doesn't update when I put menu back with that inset button)
   - [TS01](toolbar-and-shortcuts.md#ts01). D3 in 055240f3b; meaning of the number was explicitly still pending then.

6. Low performance on deselecting list item on some text in the middle of a large note
   - [PF05](large-notes-and-performance.md#pf05). Same report in 055240f3b §E; test local toggle separately from whole-note commands.

7. Double tapping a word doesn't select it
   - [PT04](pointer-and-touch.md#pt04). B1 in 055240f3b; desktop double-click has engine-owned segmentation.

8. Triple tapping sometimes doesn't cause the selection handles to come up; seems to alternate
   - [PT13](pointer-and-touch.md#pt13). B2 in 055240f3b; mobile-only action-mode mechanics, desktop rule PT05.

9. Select all: looks like it just paints a highlight over the screen, and it doesn't reach the top of the view
   - [CS07](caret-and-selection.md#cs07). C2 in 055240f3b; distinguish paint coverage from logical range.

10. Backspacing at the front of a header just removes the header when it should move it up a line (remove the new line before it, as if the caret is left of the heading syntax)

- [HG02](headings.md#hg02). 2A in 055240f3b; desktop 8d40149a9 and d0e7f7de9; mobile difference HG03.

11. Still having times when I type and nothing comes out, when typing and changing bold / italics / strikethrough constantly

- [TI02](typing-and-composition.md#ti02). F1 in 055240f3b; typed-delimiter repair commits name dropped input.

12. Heading with bold / italics / strikethrough syntax renders strikethrough but not italics or bold, and isn't showing the asterisks either. Pick whether headings can have bold / italics / strikethrough or not, then make behaviour match (do research)

- [IF01](inline-formats.md#if01). 1A/A1 in 055240f3b explicitly allows emphasis and identifies TfHeading typeface overwrite; README H adds code and external comparison.

13. Selecting all moves the view to the bottom of the page

- [SV01](scrolling-and-viewport.md#sv01). C1 in 055240f3b identifies bringPointIntoView(selectionEnd).

14. Selecting all on a larger note and pressing quote does nothing (note had headings, bold, italics, strikethrough, maybe more)

- [LQ14](lists-tasks-quotes.md#lq14). C3 in 055240f3b; engine mixed-note regression exists.

15. Selecting all on a larger note and pressing code block crashed the app

- [CB07](code-blocks.md#cb07). 5A/C4 in 055240f3b; !471 separately records line joining.

16. The toolbar should update to show what you can and can't do based on the state of the caret / selection

- [TS02](toolbar-and-shortcuts.md#ts02). Decision 4 and D1/D2 in 055240f3b; !594 supplies shared mapping.

17. Image at the end of a note: can't get the cursor after it. Idea A: always add a new line after an image placed at the end. But what if they delete the new line? Preferred idea: tap the image to select it, then Enter adds a new line below (what was done for code blocks in the past)

- [IM01](images.md#im01). Current portable image Enter rule plus !300 code-object precedent; no earlier source found for this exact image complaint.

18. New note, hit block quote in toolbar, type something: doesn't look like a block quote. Hit Enter: now it does, but there are two blank lines in the quote and the cursor is on the second of 3 lines

- [LQ11](lists-tasks-quotes.md#lq11). Engine quote-toggle and one-physical-line Enter rules cover expected result; no source found for the exact delayed first-paint failure.

19. No way to exit a code block besides placing the cursor elsewhere; a problem when the code block is the last line. Same with images. Maybe always have a newline at the end of documents. Tapping the code block button a second time should toggle it for that line and end it

- [CB04](code-blocks.md#cb04). 5fc5fda62 introduced a CM6 blank-line exit; engine has empty-last-line exit and active Code-off, CB05/CB06; image IM01.

20. Caret not rendering properly with italics especially; also overlapping a lot on bold

- [CS09](caret-and-selection.md#cs09). !336 fixes different empty-task geometry; no source found for this exact italic-overlap root cause.

21. Tapping links not working (google.com)

- [LK01](links-and-wikilinks.md#lk01). !1, !336 and external-links spec establish URL activation; !631 distinguishes prompt destination policy from bare-text parsing.

22. Note reloads when leaving and going back: the blank-screen wait, and scroll position in notes is not kept

- [SV02](scrolling-and-viewport.md#sv02). !33/!410 establish desktop scroll restoration; PF07 separately records progressive-open work, not an inferred no-reload cache requirement.

23. New line > strikethrough on > type > bold and italics on too > typing does nothing. Also can't type with strikethrough and italics on

- [TI02](typing-and-composition.md#ti02). Same class as 055240f3b F1; exact sequence still needs a desktop slice-3 story.

24. Can't tap quote and code block buttons to reverse them

- [LQ11](lists-tasks-quotes.md#lq11). Quote-off and CB06 Code-off are now specified; no source found for a separate original incident beyond the maintainer list.

25. Enabling quote or code block on a line removes the caret but keeps the keyboard up; caret not rendering inside a code block / quote line

- [CB02](code-blocks.md#cb02). Code empty/EOF ownership is covered by !620/!628; quote rendering LQ11; exact host caret disappearance remains unverified.

26. Got randomly thrown to the bottom of the note

- [SV07](scrolling-and-viewport.md#sv07). Several proven historical causes, no evidence identifying which one this report hit.

27. Putting the caret above an H1 cuts it off

- [CS10](caret-and-selection.md#cs10). Fixed desktop rhythm gives a concrete criterion; no earlier source found for the exact crop.

28. Screen not scrolling down to meet the caret fast enough while typing; looks debounced

- [SV04](scrolling-and-viewport.md#sv04). Custom Enter missing scrollIntoView in ios-keyboard-editor-jump; exact current debounce cause unverified.

29. Loading a large note takes a long time and is not sequential, so the screen is blank for a while

- [PF07](large-notes-and-performance.md#pf07). Long-note history !367/!380 and Mason's measured 2026-11-10 deferred progressive open.

30. Narrow rectangle blocking the view at the bottom

- [SV12](scrolling-and-viewport.md#sv12). No source found for the rectangle's identity; do not invent loading-bar/keyboard blame.

31. Line height changing on a header when nothing is written vs when a character is present

- [CS10](caret-and-selection.md#cs10). Desktop fixed row-unit contract; #385/#384 show related iOS empty-heading style issues, not proof of this Android cause.

32. New line > H1 > type header > Return: the caret is cut off

- [CS10](caret-and-selection.md#cs10). Desktop heading Enter/row rhythm rules; no source found for the exact crop root cause.

The four additional decisions map to [MD01](markdown-fidelity.md#md01), [CS02](caret-and-selection.md#cs02), [CS14](caret-and-selection.md#cs14), [TS02](toolbar-and-shortcuts.md#ts02): no silent typed-marker escapes; stable soft-wrap row; fix sibling bugs as a class; active/disabled/toggle-off toolbar state.
