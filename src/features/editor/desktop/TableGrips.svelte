<script lang="ts">
  /* The row and column grips of the cell the pointer is over (editorTables.ts follows the
   * pointer, tableGrips.ts places them on the caret's frame): each the app's dropdown menu (the
   * note's ⋮ menu), Insert before, Insert after and Delete, the engine's row or column commands
   * on that cell, with what the engine disallows there disabled (read when the menu opens). An
   * open menu pins its cell. A press keeps focus and the selection where they are. */
  import { untrack } from 'svelte';
  import { GripHorizontal, GripVertical } from '@lucide/svelte';
  import type { TableCommand, TableControls } from '@futo-notes/editor/wasm-payloads';
  import DropdownMenu, { type DropdownMenuEntry } from '$shared/dialogs/DropdownMenu.svelte';
  import { localizedText } from '$shared/localization';
  import type { TableGripsState } from './tableGrips';

  type GripKind = 'row' | 'column';

  interface Props {
    grips: TableGripsState | null;
    /** What the engine allows on the hovered cell. */
    oncontrols: () => TableControls | null;
    oncommand: (command: TableCommand) => void;
    /** A menu opened (true) or closed (false). */
    onpin: (pinned: boolean) => void;
  }

  let { grips, oncontrols, oncommand, onpin }: Props = $props();

  let open = $state<GripKind | null>(null);
  let controls = $state<TableControls | null>(null);

  const ITEMS: Record<GripKind, Array<[TableCommand, keyof TableControls]>> = {
    row: [
      ['InsertRowAbove', 'insert_row_above'],
      ['InsertRowBelow', 'insert_row_below'],
      ['DeleteRow', 'delete_row'],
    ],
    column: [
      ['InsertColumnLeft', 'insert_column_left'],
      ['InsertColumnRight', 'insert_column_right'],
      ['DeleteColumn', 'delete_column'],
    ],
  };
  const LABELS = [
    'editor.tableGrips.insertBefore',
    'editor.tableGrips.insertAfter',
    'editor.tableGrips.delete',
  ];

  function entriesOf(kind: GripKind): DropdownMenuEntry[] {
    return ITEMS[kind].map(([command, allowed], index) => ({
      label: { path: LABELS[index] },
      onclick: () => oncommand(command),
      destructive: command.startsWith('Delete'),
      disabled: !controls?.[allowed],
      testId: `table-grip-${command}`,
    }));
  }

  function toggle(kind: GripKind): void {
    if (open === kind) {
      open = null;
      return;
    }
    controls = oncontrols();
    open = kind;
  }

  $effect(() => {
    if (!grips || (open === 'column' && !grips.column)) open = null;
  });

  $effect(() => {
    const pinned = open !== null;
    untrack(() => onpin(pinned));
  });
</script>

{#if grips}
  <!-- Presses on the grips and their menus keep the editor's focus and selection. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="desktop-table-grips" onmousedown={(event) => event.preventDefault()}>
    <div
      class="table-grip-anchor row-grip"
      style:transform={`translate(${grips.row.left}px, ${grips.row.top}px)`}
      style:--table-row-height={`${grips.row.height}px`}
    >
      <DropdownMenu
        open={open === 'row'}
        ontoggle={() => toggle('row')}
        onclose={() => (open = null)}
        entries={entriesOf('row')}
        label={localizedText('editor.tableGrips.rowOptionsAccessibilityLabel')}
        toggleClass="table-grip"
      >
        <GripVertical size={12} strokeWidth={2.25} />
      </DropdownMenu>
    </div>
    {#if grips.column}
      <div
        class="table-grip-anchor"
        style:transform={`translate(${grips.column.left}px, ${grips.column.top}px)`}
      >
        <DropdownMenu
          open={open === 'column'}
          ontoggle={() => toggle('column')}
          onclose={() => (open = null)}
          entries={entriesOf('column')}
          label={localizedText('editor.tableGrips.columnOptionsAccessibilityLabel')}
          toggleClass="table-grip"
        >
          <GripHorizontal size={12} strokeWidth={2.25} />
        </DropdownMenu>
      </div>
    {/if}
  </div>
{/if}
