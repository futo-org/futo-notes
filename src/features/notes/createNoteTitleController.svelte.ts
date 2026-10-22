import { FORBIDDEN_CHARS_RE, validateTitle } from '$lib/rules';
import { runWhenPointerIdle } from '$shared/dom/pointerGesture';
import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';
import { titleValidationMessage } from './titleValidationMessage';

interface NoteTitleControllerOptions {
  setTitle: (title: string) => void;
  hasDuplicateTitle: (title: string) => boolean;
  scheduleSave: () => void;
  flushSave: () => void;
  focusEditor: () => void;
  getTextarea: () => HTMLTextAreaElement | undefined;
}

export function createNoteTitleController(options: NoteTitleControllerOptions) {
  let warning = $state<LocalizedMessage | null>(null);
  let warningTimer: number | null = null;

  function showWarning(message: LocalizedMessage, autoHideMilliseconds: number | null): void {
    if (warningTimer !== null) window.clearTimeout(warningTimer);
    warning = message;
    warningTimer =
      autoHideMilliseconds === null
        ? null
        : window.setTimeout(() => {
            warning = null;
            warningTimer = null;
          }, autoHideMilliseconds);
  }

  function clearWarning(): void {
    if (warningTimer !== null) window.clearTimeout(warningTimer);
    warning = null;
    warningTimer = null;
  }

  function autoResizeTextarea(): void {
    const textarea = options.getTextarea();
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  }

  function handleInput(event: Event): void {
    const input = event.target as HTMLTextAreaElement;
    const typed = input.value;
    const withoutNewlines = typed.replace(/[\r\n]/g, '');
    const cleaned = withoutNewlines.replace(FORBIDDEN_CHARS_RE, '');
    options.setTitle(cleaned);

    if (typed !== cleaned) {
      // Written here, not left to the `value` binding: it skips a title that
      // didn't change, so stripping "a/" back to "a" would leave the "/" shown.
      const beforeCaret = typed.slice(0, input.selectionStart ?? typed.length);
      const caret = beforeCaret.replace(/[\r\n]/g, '').replace(FORBIDDEN_CHARS_RE, '').length;
      input.value = cleaned;
      input.setSelectionRange(caret, caret);
    }

    if (withoutNewlines !== cleaned) {
      showWarning({ path: 'notes.title.forbiddenCharacter' }, 2000);
    } else if (typed === cleaned) {
      const issue = validateTitle(cleaned).find(
        (item) =>
          item.kind === 'leading_dots' || item.kind === 'trailing_dots' || item.kind === 'too_long',
      );
      if (issue) showWarning(titleValidationMessage(issue.kind), null);
      else if (options.hasDuplicateTitle(cleaned)) {
        showWarning({ path: 'notes.title.duplicate' }, null);
      } else clearWarning();
    }

    autoResizeTextarea();
    options.scheduleSave();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    options.focusEditor();
  }

  function handleBlur(): void {
    runWhenPointerIdle(options.flushSave);
  }

  function selectAll(input: HTMLTextAreaElement): void {
    input.setSelectionRange(0, input.value.length);
    const untouched = input.value;
    // A keystroke inside that frame already replaced the selection; selecting
    // it again would let the next keystroke erase it.
    requestAnimationFrame(() => {
      if (input.value === untouched) input.setSelectionRange(0, input.value.length);
    });
  }

  function handleFocus(event: FocusEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (input.value.startsWith('Untitled')) selectAll(input);
  }

  function handlePointerDown(event: PointerEvent): void {
    const input = event.currentTarget as HTMLTextAreaElement;
    if (!input.value.startsWith('Untitled')) return;
    event.preventDefault();
    input.focus();
    selectAll(input);
  }

  return {
    get warning() {
      return warning ? resolveLocalizedMessage(warning) : '';
    },
    showWarning,
    clearWarning,
    autoResizeTextarea,
    handleInput,
    handleKeydown,
    handleBlur,
    handleFocus,
    handlePointerDown,
  };
}
