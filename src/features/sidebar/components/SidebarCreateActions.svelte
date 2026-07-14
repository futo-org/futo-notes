<script lang="ts">
  interface Props {
    onclicknewfolder: () => void;
    onclicknewnote: () => void;
    ontouchcancel: () => void;
    ontouchend: () => void;
    ontouchstart: () => void;
  }

  let { onclicknewfolder, onclicknewnote, ontouchcancel, ontouchend, ontouchstart }: Props =
    $props();
</script>

<div class="fab-row">
  <button
    class="fab"
    aria-label="New note"
    {ontouchstart}
    {ontouchend}
    {ontouchcancel}
    onclick={onclicknewnote}
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
    New
  </button>
  <button
    class="fab fab-folder"
    aria-label="New folder"
    data-testid="new-folder-btn"
    onclick={onclicknewfolder}
  >
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path
        d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
      />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </svg>
  </button>
</div>
