<script lang="ts">
  import type { SyncSummary } from '$features/sync/syncServiceE2ee';
  import { localizedText } from '$shared/localization';

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
      label: () => localizedText('settings.debug.syncErrorTest.scenarios.uploadHttp500'),
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: 500 }],
      message: "1 change couldn't reach the server (HTTP 500)",
    },
    {
      label: () => localizedText('settings.debug.syncErrorTest.scenarios.uploadHttp403'),
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: 403 }],
      message: "1 change couldn't reach the server (HTTP 403)",
    },
    {
      label: () => localizedText('settings.debug.syncErrorTest.scenarios.deleteHttp500'),
      failures: [{ filename: 'note.md', kind: 'delete' as const, statusCode: 500 }],
      message: "1 change couldn't reach the server (HTTP 500)",
    },
    {
      label: () => localizedText('settings.debug.syncErrorTest.scenarios.networkWithoutStatus'),
      failures: [{ filename: 'note.md', kind: 'upload' as const, statusCode: null }],
      message: "1 change couldn't reach the server",
    },
    {
      label: () => localizedText('settings.debug.syncErrorTest.scenarios.threeFailures'),
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
  <h3 class="settings-section-title">
    {localizedText('settings.debug.syncErrorTest.heading')}
  </h3>
  <div class="settings-card">
    <p class="settings-btn-desc settings-hint">
      {localizedText('settings.debug.syncErrorTest.description')}
    </p>
    <div class="settings-actions" style="flex-wrap: wrap; gap: 8px; margin-top: 10px">
      {#each scenarios as scenario}
        <button
          class="settings-btn settings-btn-inline"
          onclick={() => void simulate(fakeSummary(scenario.failures, scenario.message))}
          >{scenario.label()}</button
        >
      {/each}
      <button
        class="settings-btn settings-btn-inline"
        onclick={() => void simulate(fakeSummary([]), 'manual')}
        >{localizedText('settings.debug.syncErrorTest.successfulSync')}</button
      >
    </div>
  </div>
</section>
