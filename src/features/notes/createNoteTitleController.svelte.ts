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
    let cleaned = input.value.replace(/[\r\n]/g, '');
    const withoutForbidden = cleaned.replace(FORBIDDEN_CHARS_RE, '');
    const hadForbidden = cleaned !== withoutForbidden;
    cleaned = withoutForbidden;
    options.setTitle(cleaned);

    if (hadForbidden) {
      const position = input.selectionStart ?? cleaned.length;
      requestAnimationFrame(() => input.setSelectionRange(position - 1, position - 1));
      showWarning({ path: 'notes.title.forbiddenCharacter' }, 2000);
    } else if (input.value !== cleaned) {
      const position = input.selectionStart ?? cleaned.length;
      requestAnimationFrame(() => input.setSelectionRange(position, position));
    } else {
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
    requestAnimationFrame(() => input.setSelectionRange(0, input.value.length));
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
