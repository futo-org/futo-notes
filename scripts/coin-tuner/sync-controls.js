// The list of functions that pull each control's displayed value back from the state.

export const syncers = [];

export function syncControls() {
  for (const sync of syncers) sync();
}
