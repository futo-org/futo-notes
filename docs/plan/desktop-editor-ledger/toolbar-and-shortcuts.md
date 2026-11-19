# Toolbar and shortcuts

### TS01

- **Rule:** The toolbar reports active formats for the current caret or entire selection immediately after a move, command or reopening.
- **Why / history:** Fresh stale-highlight and unlit heading-number complaints were already D1/D3 in the Android feedback plan.
- **Evidence:** 055240f3b (android-text-first); markdown-toolbar/toolbar-commands.md; maintainer list, 2026-11-10
- **Applies:** `slice 3`. **Check:** needs a desktop reopen-toolbar and selection-state story

### TS02

- **Rule:** An active format button turns its format off and an inapplicable command is disabled rather than hidden.
- **Why / history:** Mason reaffirmed the rule on 2026-11-10; the engine's active and eligible state must describe the actual next action.
- **Evidence:** Maintainer decision, 2026-11-10; !594; !604; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** tests/host_toolbar_ids.rs; needs full control/action matrix

### TS03

- **Rule:** Inline format buttons light only when all selected eligible inline bodies carry the format.
- **Why / history:** Android feedback decision 4 was provisional but current engine specs choose whole-selection coverage; older Milkdown used any occurrence.
- **Evidence:** 055240f3b decision 4 (android-text-first); !275; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** tests/inline/multi_block.rs; README decision T

### TS04

- **Rule:** A task lights Task without also lighting Bullet, and mixed block kinds do not falsely claim one common kind.
- **Why / history:** Heading and Quote use their own all-eligible-line rules; H4–H6 are separately covered in HG08.
- **Evidence:** markdown-toolbar/toolbar-commands.md; !594
- **Applies:** `slice 4`. **Check:** tests/host_toolbar_ids.rs; needs selection-matrix story

### TS05

- **Rule:** Heading controls select explicit levels instead of cycling through unrelated heading levels.
- **Why / history:** !252's earlier heading-cycle semantics were replaced by explicit Text/H1/H2/H3 plus active-button toggling.
- **Evidence:** !252; markdown-toolbar/toolbar-commands.md; portable-core/block-commands.md
- **Applies:** `slice 3`. **Check:** tests/blocks/toggle.rs

### TS06

- **Rule:** Shortcuts and toolbar commands share the same rule owner and eligibility.
- **Why / history:** !413 showed preset shortcuts could destroy code even when toolbar buttons were guarded; Caps Lock variants also need parity.
- **Evidence:** !413; !448; src/AGENTS.md
- **Applies:** `slice 3`. **Check:** needs Caps Lock, uppercase event and platform chord stories

### TS07

- **Rule:** A selected block format targets each written touched line without formatting the unwritten final parking line.
- **Why / history:** !471 fixed Select All Code block joining lines; !448 stops stray trailing markers after double toggles.
- **Evidence:** !448; !471; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 4`. **Check:** needs Select All for every block control and a caret-only-final-line control

### TS08

- **Rule:** Formatting controls do not steal the editor selection while they execute.
- **Why / history:** Toolbar focus and stale ranges have historically made commands apply to the wrong place; native touch must keep the keyboard up.
- **Evidence:** !3; !160; !536; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** needs desktop selection-preserving control click story

### TS09

- **Rule:** Floating editor controls remain below blocking dialogs and within the visible viewport.
- **Why / history:** !118 review demanded shared stacking tiers and Search coverage; !413 fixed the Link prompt overflowing a narrow viewport.
- **Evidence:** !118 discussion; !413; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** needs Settings/Search/folder overlay hit-tests and narrow prompt story

### TS10

- **Rule:** Link creation uses the app's prompt or engine command instead of window.prompt.
- **Why / history:** WKWebView returns null from window.prompt, silently canceling Link; !160's scaffold later became the shared URL prompt.
- **Evidence:** !160; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 5`. **Check:** needs real WKWebView Link story

### TS11

- **Rule:** Native formatting bars dock flush to the keyboard and keep their horizontal scroll affordance.
- **Why / history:** The 44pt/dp bar centers 36pt/dp buttons; safe-area padding reopened a keyboard gap. Overflow clips an edge icon to about 55% with a ten-point fade, and its measured viewport must not follow scroll bounce.
- **Evidence:** 9bc001a92; !302; 954bffbb5; markdown-toolbar/native-toolbar-chrome.md
- **Applies:** `mobile only`. **Check:** Keyboard accessory geometry differs from desktop toolbar; retain as mobile prior art

### TS12

- **Rule:** The toolbar's manifest defines order, labels and accessibility once, while the engine defines behavior.
- **Why / history:** Shared state must update from the selection's own current document rather than a stale view snapshot.
- **Evidence:** packages/editor/src/toolbar.ts; !594; markdown-toolbar/toolbar-commands.md
- **Applies:** `slice 3`. **Check:** needs manifest-to-command desktop coverage without host-side Markdown rules

### TS13

- **Rule:** Changing the interface language updates editor controls in place while retaining note content, filename and editing state.
- **Why / history:** !271 applies catalog UI without reloading the note; Android avoids activity recreation. A translated Untitled placeholder never becomes a translated filename.
- **Evidence:** !271; tests/language-settings.spec.ts; docs/spec/editor/localization.md.
- **Applies:** `desktop now`. **Check:** existing filename lock; needs language-switch-during-edit story.

### TS14

- **Rule:** Theme changes repaint editor controls and their surrounding surfaces together.
- **Why / history:** Mason's !232 removed theme-dependent color transitions that trailed the note view by 100–200 ms; !269 fixed the same class in native bars and dialogs. Motion and opacity feedback remain where they do not delay theme colors.
- **Evidence:** !232; !269; docs/spec/app.md appearance.
- **Applies:** `slice 3`. **Check:** needs theme-switch story with toolbar and prompt open; existing theme-single-pace gate checks declarations.

### TS15

- **Rule:** A hidden toolbar performs no viewport measurement work.
- **Why / history:** !550 found hidden web-toolbar listeners still measuring during keyboard animation; subscriptions now exist only while visible and are released on hide or teardown.
- **Evidence:** !550; hidden-toolbar lifecycle regression.
- **Applies:** `slice 3`. **Check:** needs show/hide/resize lifecycle story; no repeated layout while hidden.

### TS16

- **Rule:** The floating formatting bar appears only for an eligible nonempty text selection.
- **Why / history:** Bare carets, whitespace-only ranges, nodes, code and composition do not summon it. The caret-only Indent/Outdent popup was removed on Mason's 2026-09-15 decision because it was intrusive.
- **Evidence:** docs/spec/editor/interactive-elements.md, floating selection toolbar.
- **Applies:** `slice 3`. **Check:** needs a story for eligible/ineligible ranges, blur and selection-preserving clicks.

### TS17

- **Rule:** The slash menu opens only for a slash at a line's start outside code and Escape dismisses that same slash run.
- **Why / history:** Label-prefix matches rank ahead of keyword matches; unmatched input hides the menu, and arrow keys, Enter and Tab select a result without reopening after Escape.
- **Evidence:** docs/spec/editor/interactive-elements.md, slash commands.
- **Applies:** `slice 3`. **Check:** needs matching, unmatched, Escape-memory and keyboard-choice stories.

### TS18

- **Rule:** Choosing a slash command removes its query and applies the command as one Undo action.
- **Why / history:** The user must not Undo twice or retain a slash fragment after applying a block or formatting command.
- **Evidence:** docs/spec/editor/interactive-elements.md, slash commands.
- **Applies:** `slice 3`. **Check:** needs a story that one Undo restores the complete typed slash query.
