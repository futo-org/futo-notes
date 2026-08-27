<script lang="ts">
  /**
   * The inline rename field shared by folder rows and note rows.
   *
   * One owner for the whole gesture contract — focus + select on open, Enter to
   * commit, Escape to cancel, blur to commit, and a REPORTED failure that keeps
   * the text editable — so the two row types cannot drift apart, and so a
   * rejected name is never silently thrown away.
   *
   * Failures surface as the app-wide toast: the tree is virtualized on a uniform
   * row pitch, so an error line inside a row would desync the scroll maths, and
   * the previous "red border plus a `title` tooltip" told the user nothing.
   */
  import { onMount, tick, untrack } from 'svelte';

  import { showGlobalToast } from '$shared/notifications/toastBus.svelte';
  import { resolveLocalizedMessage, type LocalizedMessage } from '$shared/localization';

  interface Props {
    /** Name to seed the field with (the current leaf). */
    initialValue: string;
    /** Accessible name for the field, e.g. "Folder name". */
    label: string;
    testId: string;
    /** Commit. Returns an error message to keep the field open, or null on success. */
    onsubmit: (value: string) => Promise<LocalizedMessage | null> | LocalizedMessage | null;
    /** Leave rename mode (success or cancel). */
    onclose: () => void;
  }

  let { initialValue, label, testId, onsubmit, onclose }: Props = $props();

  // Seeded once: the field owns the text from the moment it opens.
  let value = $state(untrack(() => initialValue));
  let error = $state<LocalizedMessage | null>(null);
  let isSubmitting = $state(false);
  let input: HTMLInputElement | undefined = $state();

  onMount(() => {
    input?.focus();
    input?.select();
  });

  async function submit(refocusOnFailure: boolean): Promise<void> {
    if (isSubmitting) return;
    isSubmitting = true;
    error = null;
    try {
      const failure = await onsubmit(value);
      if (!failure) {
        onclose();
        return;
      }
      error = failure;
      showGlobalToast(failure);
    } catch {
      console.warn('Inline rename failed');
      error = { path: 'common.errors.renameFailed' };
      showGlobalToast({ path: 'common.errors.renameFailed' });
    } finally {
      isSubmitting = false;
    }
    // The field stays open holding what the user typed, so a rejected name is
    // fixable in place instead of lost. Only a keyboard commit pulls the caret
    // back — yanking focus out of wherever the user just clicked would fight
    // them for it.
    if (!refocusOnFailure) return;
    await tick();
    input?.focus();
    input?.select();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void submit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onclose();
    }
  }
</script>

<!-- The row behind this is a click/dblclick target; swallow those here so
     clicking into the field does not also toggle or reopen the row. -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<span
  class="folder-inline-edit"
  onclick={(event) => event.stopPropagation()}
  ondblclick={(event) => event.stopPropagation()}
  onkeydown={(event) => event.stopPropagation()}
>
  <input
    bind:this={input}
    bind:value
    class:error={error !== null}
    disabled={isSubmitting}
    aria-label={label}
    aria-invalid={error !== null}
    title={error ? resolveLocalizedMessage(error) : label}
    autocomplete="off"
    autocapitalize="none"
    spellcheck="false"
    onkeydown={handleKeydown}
    onblur={() => !isSubmitting && void submit(false)}
    data-testid={testId}
  />
</span>
