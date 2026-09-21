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
 * lives in a native shell: every toolbar dispatches `exec(item.id)` — over the
 * bridge on the native shells — into the one shared implementation for
 * Milkdown editor (`src/features/editor/milkdown/toolbarExec.ts`).
 */

/** What tapping a toolbar item does. */
export type ToolbarAction =
  /** Run the shared editor command: `FutoEditor.exec(item.id)`. */
  | { kind: 'exec' }
  /**
   * Ask the host for an image (`pickImage` outbound message on native). The
   * host saves the bytes into the vault and calls `insertImage(filename)` back.
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
  localizationPath: string;
  /** Optional visible text, used for explicit heading levels. */
  text?: string;
  /** Icon name in `@lucide/svelte` (web renderers). */
  lucide: string;
  /** SF Symbol name (native iOS renderer). */
  sfSymbol: string;
  /** Material Symbols name (native Android renderer). */
  material: string;
  /** Indentation is available inside lists and quotes. */
  when: 'always' | 'inContainer';
  action: ToolbarAction;
}

const EXEC: ToolbarAction = { kind: 'exec' };

/**
 * The scrollable toolbar body. Groups render with a separator between them;
 * items render left-to-right in array order.
 */
export const TOOLBAR_GROUPS: ToolbarItem[][] = [
  [
    // QA-003: first items on the mobile toolbar, ahead of every formatting
    // control. Editing behavior is prosemirror-history's own `undo`/`redo`
    // commands (toolbarExec.ts), never a hand-rolled stack. Their enabled
    // state is NOT selection-driven like every other button here — it rides
    // the same bridge `formatState` message, in its `disabled` field
    // (bridge.ts FormatStateMessage), computed from `undoDepth`/`redoDepth`
    // (formatState.ts `computeDisabledFormats`).
    {
      id: 'undo',
      localizationPath: 'editor.toolbar.undo',
      lucide: 'Undo2',
      sfSymbol: 'arrow.uturn.backward',
      material: 'undo',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'redo',
      localizationPath: 'editor.toolbar.redo',
      lucide: 'Redo2',
      sfSymbol: 'arrow.uturn.forward',
      material: 'redo',
      when: 'always',
      action: EXEC,
    },
  ],
  [
    {
      id: 'bold',
      localizationPath: 'editor.toolbar.bold',
      lucide: 'Bold',
      sfSymbol: 'bold',
      material: 'format_bold',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'italic',
      localizationPath: 'editor.toolbar.italic',
      lucide: 'Italic',
      sfSymbol: 'italic',
      material: 'format_italic',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'strikethrough',
      localizationPath: 'editor.toolbar.strikethrough',
      lucide: 'Strikethrough',
      sfSymbol: 'strikethrough',
      material: 'format_strikethrough',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'link',
      localizationPath: 'editor.toolbar.link',
      lucide: 'Link',
      sfSymbol: 'link',
      material: 'link',
      when: 'always',
      action: EXEC,
    },
  ],
  [
    {
      id: 'paragraph',
      localizationPath: 'editor.toolbar.paragraph',
      text: 'Text',
      lucide: 'Type',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-1',
      localizationPath: 'editor.toolbar.headingOne',
      text: 'H1',
      lucide: 'Heading1',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-2',
      localizationPath: 'editor.toolbar.headingTwo',
      text: 'H2',
      lucide: 'Heading2',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-3',
      localizationPath: 'editor.toolbar.headingThree',
      text: 'H3',
      lucide: 'Heading3',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'quote',
      localizationPath: 'editor.toolbar.blockQuote',
      lucide: 'TextQuote',
      sfSymbol: 'text.quote',
      material: 'format_quote',
      when: 'always',
      action: EXEC,
    },
    // QA-009: was missing on every mobile shell (there was no manifest item
    // at all, not an Android-only gap) — Android and iOS both get it now.
    // One-way (paragraph → code), matching the `/` menu's existing Code block
    // item (slash/exec.ts `createCodeBlockCommand`) rather than inventing a
    // toggle back OUT of code the block-conversion model doesn't support
    // (blockCommands.ts `applyCommand`/`stripCommand` both already refuse a
    // `code` target/source).
    {
      id: 'code-block',
      localizationPath: 'editor.toolbar.codeBlock',
      lucide: 'Code',
      sfSymbol: 'chevron.left.forwardslash.chevron.right',
      material: 'code',
      when: 'always',
      action: EXEC,
    },
  ],
  [
    {
      id: 'bullet-list',
      localizationPath: 'editor.toolbar.bulletList',
      lucide: 'List',
      sfSymbol: 'list.bullet',
      material: 'format_list_bulleted',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'ordered-list',
      localizationPath: 'editor.toolbar.orderedList',
      lucide: 'ListOrdered',
      sfSymbol: 'list.number',
      material: 'format_list_numbered',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'task-list',
      localizationPath: 'editor.toolbar.taskList',
      lucide: 'ListChecks',
      sfSymbol: 'checklist',
      material: 'checklist',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'outdent',
      localizationPath: 'editor.toolbar.outdent',
      lucide: 'ListIndentDecrease',
      sfSymbol: 'decrease.indent',
      material: 'format_indent_decrease',
      when: 'inContainer',
      action: EXEC,
    },
    {
      id: 'indent',
      localizationPath: 'editor.toolbar.indent',
      lucide: 'ListIndentIncrease',
      sfSymbol: 'increase.indent',
      material: 'format_indent_increase',
      when: 'inContainer',
      action: EXEC,
    },
  ],
  [
    {
      id: 'camera',
      localizationPath: 'editor.toolbar.takePhoto',
      lucide: 'Camera',
      sfSymbol: 'camera',
      material: 'photo_camera',
      when: 'always',
      action: { kind: 'pickImage', source: 'camera' },
    },
    {
      id: 'image',
      localizationPath: 'editor.toolbar.chooseFromLibrary',
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
  localizationPath: 'editor.toolbar.dismissKeyboard',
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
