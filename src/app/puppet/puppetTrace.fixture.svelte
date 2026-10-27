<script lang="ts">
  // puppetTrace.test.ts: a control whose verb only flips component state, so its effect
  // reaches the DOM on Svelte's next flush, not while the handler runs.
  import { puppetVerb, registerPuppetVerbs } from './puppetRegistry';

  let open = $state(false);

  $effect(() =>
    registerPuppetVerbs(() => [
      puppetVerb('ToggleFixture', {}, () => {
        open = !open;
      }),
      puppetVerb('ToggleFixtureLater', {}, () => {
        setTimeout(() => (open = !open), 0);
      }),
    ]),
  );
</script>

<button type="button" onclick={() => (open = !open)}>Toggle</button>
{#if open}
  <button type="button" onclick={() => (open = false)}>Close</button>
{/if}
