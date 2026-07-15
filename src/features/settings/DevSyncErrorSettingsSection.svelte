<script lang="ts">
  import type { SyncSummary } from '$features/sync/syncServiceE2ee';

  interface Props {
    simulate: (summary: SyncSummary, trigger?: 'manual') => void | Promise<void>;
  }

  let { simulate }: Props = $props();

  function fakeSummary(
    failures: SyncSummary['failures'],
    failureMessage: string | null = null,
  ): SyncSummary {
    return {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      localWritesApplied: 0,
      failures,
      failureMessage,
      updatedIds: [],
      deletedIds: [],
      renamed: [],
      peerUpdatedIds: [],
      peerDeletedIds: [],
    };
  }

  const scenarios = [
    {
      label: 'Upload 500',
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: 500 }],
      message: "1 change couldn't reach the server (HTTP 500)",
    },
    {
      label: 'Upload 403',
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: 403 }],
      message: "1 change couldn't reach the server (HTTP 403)",
    },
    {
      label: 'Delete 500',
      failures: [{ filename: 'note.md', kind: 'delete' as const, statusCode: 500 }],
      message: "1 change couldn't reach the server (HTTP 500)",
    },
    {
      label: 'Network (no status)',
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: null }],
      message: "1 change couldn't reach the server",
    },
    {
      label: '3 failures',
      failures: [
        { filename: 'a.md', kind: 'upload' as const, statusCode: 500 },
        { filename: 'b.md', kind: 'upload' as const, statusCode: 500 },
        { filename: 'c.md', kind: 'delete' as const, statusCode: 500 },
      ],
      message: "3 changes couldn't reach the server (HTTP 500)",
    },
  ];
</script>

<section class="settings-section">
  <h3 class="settings-section-title">Sync error test (dev)</h3>
  <div class="settings-card">
    <p class="settings-btn-desc settings-hint">
      Fires a fabricated sync result through the real handler — the ⚠ indicator, toast, and "Sync
      failed" line behave exactly as a server-thrown error. "Successful sync" clears it (or click
      the ⚠).
    </p>
    <div class="settings-actions" style="flex-wrap: wrap; gap: 8px; margin-top: 10px">
      {#each scenarios as scenario}
        <button
          class="settings-btn settings-btn-inline"
          onclick={() => void simulate(fakeSummary(scenario.failures, scenario.message))}
          >{scenario.label}</button
        >
      {/each}
      <button
        class="settings-btn settings-btn-inline"
        onclick={() => void simulate(fakeSummary([]), 'manual')}>Successful sync</button
      >
    </div>
  </div>
</section>
