/* Prototype toggles for tuning the desktop editor by feel, in the note's "⋮" menu in dev
 * builds only (NoteWorkspace.svelte). Held in memory: every launch starts from the defaults.
 * Their text is English only: no release build shows it. */
import type { EdgeRule } from './formats';

export const desktopEditorDebug = $state({
  /** Which side a caret at a format's edge joins (formats.ts `arrivalAffinity`). */
  formatEdge: 'cameFrom' as EdgeRule,
  /** The caret's flag is drawn. Shelved, off in every build, until its design is settled
   *  (maintainers, 2026-11-18); a dev build's menu turns it on to look at it. */
  showCaretFlag: false,
  /** The caret's flag hides from an edit until the caret moves or typing pauses. */
  hideFlagWhileTyping: false,
});

const EDGE_RULES: Array<[EdgeRule, string]> = [
  ['cameFrom', 'the side it came from'],
  ['more', 'more formatting'],
  ['left', 'always left'],
  ['right', 'always right'],
];

/** The toggles as menu entries (DropdownMenu.svelte's, their text verbatim). */
export function desktopEditorDebugEntries() {
  return [
    { heading: { verbatim: 'Debug: caret at a format edge' } },
    ...EDGE_RULES.map(([rule, text]) => ({
      label: { verbatim: text },
      checked: desktopEditorDebug.formatEdge === rule,
      onclick: () => (desktopEditorDebug.formatEdge = rule),
    })),
    {
      label: { verbatim: "Show the caret's flag" },
      checked: desktopEditorDebug.showCaretFlag,
      onclick: () => (desktopEditorDebug.showCaretFlag = !desktopEditorDebug.showCaretFlag),
    },
    {
      label: { verbatim: 'Hide the flag while typing' },
      checked: desktopEditorDebug.hideFlagWhileTyping,
      onclick: () =>
        (desktopEditorDebug.hideFlagWhileTyping = !desktopEditorDebug.hideFlagWhileTyping),
    },
  ];
}
