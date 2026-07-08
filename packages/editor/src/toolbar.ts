/**
 * The markdown-toolbar manifest — the SINGLE SOURCE OF TRUTH for the mobile
 * formatting toolbar surface: which items exist, their order and grouping,
 * their accessibility labels, their icons on every platform, and when they
 * are visible.
 *
 * Renderers consume it, they never restate it:
 *
 *   - Web (the embed's EmbedToolbar.svelte, shown on hosts without a native
 *     toolbar) renders the groups directly.
 *   - Native iOS renders `ToolbarSpec.swift`, GENERATED from this file by
 *     `scripts/gen-toolbar-spec.ts` (`just toolbar-spec`); `just
 *     toolbar-spec-check` fails when the generated copy drifts.
 *   - Native Android (Compose) renders `ToolbarSpec.kt`, generated from this
 *     file by the same script and covered by the same staleness check.
 *
 * The EDITING BEHAVIOR behind each `exec` item is not defined here and never
 * lives in a native shell: native toolbars dispatch
 * `FutoEditor.exec(item.id)` over the bridge, which runs the shared
 * CodeMirror command in `src/lib/markdownToolbar.ts` (`TOOLBAR_EXEC`). One
 * implementation of every command, identical behavior on every platform by
 * construction.
 */

/** What tapping a toolbar item does. */
export type ToolbarAction =
  /** Run the shared editor command: `FutoEditor.exec(item.id)`. */
  | { kind: 'exec' }
  /**
   * Ask the host for an image (`pickImage` outbound message on native; the
   * Tauri camera/file plugins on Tauri mobile). The host saves the bytes
   * into the vault and calls `insertImage(filename)` back.
   */
  | { kind: 'pickImage'; source: 'camera' | 'library' }
  /** Blur the editor — drops the soft keyboard and hides the toolbar. */
  | { kind: 'dismiss' };

export interface ToolbarItem {
  /** Stable id. For `exec` items this is the command id passed to `exec()`. */
  id: string;
  /**
   * Accessibility label — aria-label on web, accessibilityLabel on iOS,
   * contentDescription on Android. Identical text on every platform.
   */
  label: string;
  /** Icon name in `@lucide/svelte` (web renderers). */
  lucide: string;
  /** SF Symbol name (native iOS renderer). */
  sfSymbol: string;
  /** Material Symbols name (native Android renderer). */
  material: string;
  /** `onListLine`: only visible while the cursor is on a list line. */
  when: 'always' | 'onListLine';
  action: ToolbarAction;
}

const EXEC: ToolbarAction = { kind: 'exec' };

/**
 * The scrollable toolbar body. Groups render with a separator between them;
 * items render left-to-right in array order.
 */
export const TOOLBAR_GROUPS: ToolbarItem[][] = [
  [
    {
      id: 'bold',
      label: 'Bold',
      lucide: 'Bold',
      sfSymbol: 'bold',
      material: 'format_bold',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'italic',
      label: 'Italic',
      lucide: 'Italic',
      sfSymbol: 'italic',
      material: 'format_italic',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'strikethrough',
      label: 'Strikethrough',
      lucide: 'Strikethrough',
      sfSymbol: 'strikethrough',
      material: 'format_strikethrough',
      when: 'always',
      action: EXEC,
    },
  ],
  [
    {
      id: 'heading',
      label: 'Heading',
      lucide: 'Heading',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'quote',
      label: 'Block quote',
      lucide: 'TextQuote',
      sfSymbol: 'text.quote',
      material: 'format_quote',
      when: 'always',
      action: EXEC,
    },
  ],
  [
    {
      id: 'bullet-list',
      label: 'Bullet list',
      lucide: 'List',
      sfSymbol: 'list.bullet',
      material: 'format_list_bulleted',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'ordered-list',
      label: 'Ordered list',
      lucide: 'ListOrdered',
      sfSymbol: 'list.number',
      material: 'format_list_numbered',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'task-list',
      label: 'Task list',
      lucide: 'ListChecks',
      sfSymbol: 'checklist',
      material: 'checklist',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'outdent',
      label: 'Outdent',
      lucide: 'ListIndentDecrease',
      sfSymbol: 'decrease.indent',
      material: 'format_indent_decrease',
      when: 'onListLine',
      action: EXEC,
    },
    {
      id: 'indent',
      label: 'Indent',
      lucide: 'ListIndentIncrease',
      sfSymbol: 'increase.indent',
      material: 'format_indent_increase',
      when: 'onListLine',
      action: EXEC,
    },
  ],
  [
    {
      id: 'camera',
      label: 'Take photo',
      lucide: 'Camera',
      sfSymbol: 'camera',
      material: 'photo_camera',
      when: 'always',
      action: { kind: 'pickImage', source: 'camera' },
    },
    {
      id: 'image',
      label: 'Choose from library',
      lucide: 'ImageIcon',
      sfSymbol: 'photo',
      material: 'image',
      when: 'always',
      action: { kind: 'pickImage', source: 'library' },
    },
  ],
];

/** The fixed (non-scrolling) collapse chevron at the toolbar's right edge. */
export const TOOLBAR_DISMISS: ToolbarItem = {
  id: 'dismiss',
  label: 'Dismiss keyboard',
  lucide: 'ChevronDown',
  sfSymbol: 'keyboard.chevron.compact.down',
  material: 'keyboard_hide',
  when: 'always',
  action: { kind: 'dismiss' },
};

/** Every item, flattened (groups in order + dismiss). */
export const TOOLBAR_ITEMS: ToolbarItem[] = [...TOOLBAR_GROUPS.flat(), TOOLBAR_DISMISS];

/** Ids of the `exec` items — the command ids `FutoEditor.exec` must accept. */
export const TOOLBAR_EXEC_IDS: string[] = TOOLBAR_ITEMS.filter((i) => i.action.kind === 'exec').map(
  (i) => i.id,
);
