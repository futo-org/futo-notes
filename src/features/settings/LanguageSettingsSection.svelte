<script lang="ts">
  import { Check, ChevronDown, Globe } from '@lucide/svelte';
  import { tick } from 'svelte';
  import { dismissable } from '$shared/dialogs/dismissable';
  import { desktopLocalization, type Language } from '$shared/localization';

  interface Props {
    selectedLanguageTag: string | null;
    languages: readonly Language[];
    onchange: (selectedLanguageTag: string | null) => void;
  }

  interface LanguageOption {
    tag: string | null;
    name: string;
  }

  let { selectedLanguageTag, languages, onchange }: Props = $props();
  let languagePickerTriggerElement: HTMLButtonElement | undefined = $state();
  let languageOptionsElement: HTMLDivElement | undefined = $state();
  let languageOptionsOpen = $state(false);

  const heading = $derived(desktopLocalization.localizedText('settings.language.heading'));
  const systemOption = $derived(
    desktopLocalization.localizedText('settings.language.systemOption'),
  );
  const languageOptions = $derived<readonly LanguageOption[]>([
    { tag: null, name: systemOption },
    ...languages.map((language) => ({ tag: language.tag, name: language.nativeName })),
  ]);
  const selectedLanguageName = $derived(
    languageOptions.find((language) => language.tag === selectedLanguageTag)?.name ?? systemOption,
  );

  function languageOptionElements(): HTMLButtonElement[] {
    return Array.from(
      languageOptionsElement?.querySelectorAll<HTMLButtonElement>('.settings-language-option') ??
        [],
    );
  }

  function closeLanguageOptions(restoreTriggerFocus = false): void {
    languageOptionsOpen = false;
    if (restoreTriggerFocus) {
      void tick().then(() => languagePickerTriggerElement?.focus());
    }
  }

  async function openLanguageOptions(focusLastOption = false): Promise<void> {
    languageOptionsOpen = true;
    await tick();
    const options = languageOptionElements();
    const selectedOption = options.find(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    const focusTarget = focusLastOption ? options[options.length - 1] : selectedOption;
    (focusTarget ?? options[0])?.focus();
  }

  function toggleLanguageOptions(): void {
    if (languageOptionsOpen) closeLanguageOptions(true);
    else void openLanguageOptions();
  }

  function selectLanguageOption(selectedTag: string | null): void {
    closeLanguageOptions(true);
    onchange(selectedTag);
  }

  function handleLanguageTriggerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void openLanguageOptions(event.key === 'ArrowUp');
  }

  function handleLanguageOptionsKeydown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = languageOptionElements();
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') return options[0]?.focus();
    if (event.key === 'End') return options[options.length - 1]?.focus();
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = (currentIndex + step + options.length) % options.length;
    options[nextIndex]?.focus();
  }
</script>

<section class="settings-section">
  <h3 id="settings-language-heading" class="settings-section-title settings-language-heading">
    <Globe class="settings-language-heading-icon" size={14} aria-hidden="true" />
    <span>{heading}</span>
  </h3>
  <div class="settings-card settings-language-card">
    <div
      class="settings-language-picker"
      use:dismissable={{
        ondismiss: (reason) => closeLanguageOptions(reason === 'escape'),
        enabled: languageOptionsOpen,
        outside: true,
      }}
    >
      <button
        bind:this={languagePickerTriggerElement}
        type="button"
        class="settings-language-trigger"
        class:open={languageOptionsOpen}
        aria-labelledby="settings-language-heading settings-language-current"
        aria-haspopup="listbox"
        aria-expanded={languageOptionsOpen}
        aria-controls="settings-language-options"
        onmousedown={(event) => event.preventDefault()}
        onclick={toggleLanguageOptions}
        onkeydown={handleLanguageTriggerKeydown}
      >
        <span id="settings-language-current" class="settings-language-current"
          >{selectedLanguageName}</span
        >
        <ChevronDown
          class={languageOptionsOpen
            ? 'settings-language-chevron open'
            : 'settings-language-chevron'}
          size={19}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      </button>

      {#if languageOptionsOpen}
        <div
          bind:this={languageOptionsElement}
          id="settings-language-options"
          class="settings-language-options"
          role="listbox"
          aria-labelledby="settings-language-heading"
          tabindex="-1"
          onkeydown={handleLanguageOptionsKeydown}
        >
          {#each languageOptions as languageOption (languageOption.tag ?? 'system')}
            <button
              type="button"
              class="settings-language-option"
              class:selected={selectedLanguageTag === languageOption.tag}
              role="option"
              aria-selected={selectedLanguageTag === languageOption.tag}
              tabindex={selectedLanguageTag === languageOption.tag ? 0 : -1}
              onclick={() => selectLanguageOption(languageOption.tag)}
            >
              <span>{languageOption.name}</span>
              {#if selectedLanguageTag === languageOption.tag}
                <Check
                  class="settings-language-check"
                  size={18}
                  strokeWidth={2.5}
                  aria-hidden="true"
                />
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</section>
