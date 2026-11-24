/**
 * The markdown-toolbar manifest — the SINGLE SOURCE OF TRUTH for the mobile
 * formatting toolbar surface: which items exist, their order and grouping,
 * their accessibility labels, their icons on every platform, and when they
 * are visible.
 *
 * Renderers consume it, they never restate it:
 *
 *   - The desktop editor's selection toolbar takes its block buttons from the
 *     groups (`src/features/editor/desktop/blockButtons.ts`).
 *   - Native iOS renders `ToolbarSpec.swift`, GENERATED from this file by
 *     `scripts/gen-toolbar-spec.ts` (`just toolbar-spec`); `just
 *     toolbar-spec-check` fails when the generated copy drifts.
 *   - Native Android (Compose) renders `ToolbarSpec.kt`, generated from this
 *     file by the same script and covered by the same staleness check.
 *
 * The EDITING BEHAVIOR behind each `exec` item is not defined here: the desktop
 * editor runs it through its engine, the native shells through their Rust editor
 * sessions.
 */

/** What tapping a toolbar item does. */
export type ToolbarAction =
  /** Run the editor command the item's id names. */
  | { kind: 'exec' }
  /**
   * Ask the native shell for an image from the camera or the photo library. The
   * shell saves the bytes into the vault and inserts the image into the note.
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
    // control. Their enabled state is NOT selection-driven like every other
    // button here: it is whether the editor's history has a step to take.
    {
      id: 'undo',
      localizationPath: 'editor.toolbar.undo',
      sfSymbol: 'arrow.uturn.backward',
      material: 'undo',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'redo',
      localizationPath: 'editor.toolbar.redo',
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
      sfSymbol: 'bold',
      material: 'format_bold',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'italic',
      localizationPath: 'editor.toolbar.italic',
      sfSymbol: 'italic',
      material: 'format_italic',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'strikethrough',
      localizationPath: 'editor.toolbar.strikethrough',
      sfSymbol: 'strikethrough',
      material: 'format_strikethrough',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'link',
      localizationPath: 'editor.toolbar.link',
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
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-1',
      localizationPath: 'editor.toolbar.headingOne',
      text: 'H1',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-2',
      localizationPath: 'editor.toolbar.headingTwo',
      text: 'H2',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'heading-3',
      localizationPath: 'editor.toolbar.headingThree',
      text: 'H3',
      sfSymbol: 'textformat.size',
      material: 'format_h1',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'quote',
      localizationPath: 'editor.toolbar.blockQuote',
      sfSymbol: 'text.quote',
      material: 'format_quote',
      when: 'always',
      action: EXEC,
    },
    // QA-009: was missing on every mobile shell (there was no manifest item
    // at all, not an Android-only gap) — Android and iOS both get it now.
    {
      id: 'code-block',
      localizationPath: 'editor.toolbar.codeBlock',
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
      sfSymbol: 'list.bullet',
      material: 'format_list_bulleted',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'ordered-list',
      localizationPath: 'editor.toolbar.orderedList',
      sfSymbol: 'list.number',
      material: 'format_list_numbered',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'task-list',
      localizationPath: 'editor.toolbar.taskList',
      sfSymbol: 'checklist',
      material: 'checklist',
      when: 'always',
      action: EXEC,
    },
    {
      id: 'outdent',
      localizationPath: 'editor.toolbar.outdent',
      sfSymbol: 'decrease.indent',
      material: 'format_indent_decrease',
      when: 'inContainer',
      action: EXEC,
    },
    {
      id: 'indent',
      localizationPath: 'editor.toolbar.indent',
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
      sfSymbol: 'camera',
      material: 'photo_camera',
      when: 'always',
      action: { kind: 'pickImage', source: 'camera' },
    },
    {
      id: 'image',
      localizationPath: 'editor.toolbar.chooseFromLibrary',
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
  sfSymbol: 'keyboard.chevron.compact.down',
  material: 'keyboard_hide',
  when: 'always',
  action: { kind: 'dismiss' },
};

/** Every item, flattened (groups in order + dismiss). */
export const TOOLBAR_ITEMS: ToolbarItem[] = [...TOOLBAR_GROUPS.flat(), TOOLBAR_DISMISS];
