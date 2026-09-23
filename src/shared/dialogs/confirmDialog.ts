import { requestConfirmation, type ConfirmDialogOptions } from './confirmDialogState.svelte';

export async function confirmDialog(
  message: string,
  options: ConfirmDialogOptions,
): Promise<boolean> {
  return requestConfirmation(message, options);
}
