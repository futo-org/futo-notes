// A verb whose control asks "are you sure?" goes through the same dialog a click opens, so
// the act runs its whole real path: the verb stops with the dialog on screen, and the
// dialog's own `ConfirmDialog` or `DismissDialog` answers it. `answer` is the CLI pressing
// one of them next (futo-puppet's `answer_through_dialog`), never the verb answering itself.
import { continuesWith, currentConfirmDialog } from '$shared/dialogs/confirmDialogState.svelte';

import { puppetRefusal, type PuppetOutcome } from './puppetRegistry';

/** The argument every such verb takes: the CLI's step after it, which its run ignores. */
export const ANSWER_PARAM = { answer: 'confirm|dismiss?' } as const;

/**
 * Runs `act` (the click handler's own call) until it asks, and hands the rest of it to the
 * dialog, so answering waits for what the answer starts. An act that ends without asking —
 * nothing to delete, a refusal toast — simply ends.
 */
export async function throughConfirmation(
  act: () => Promise<unknown>,
): Promise<PuppetOutcome | undefined> {
  // A person cannot reach a button behind an open dialog, and answering would answer that one.
  if (currentConfirmDialog()) {
    return puppetRefusal(409, 'a confirmation is already open: ConfirmDialog or DismissDialog');
  }
  const done = act();
  if (await untilAsked(done)) continuesWith(done);
  else await done;
  return undefined;
}

/** True once the act has put a confirmation on screen, false if it finished first. */
function untilAsked(done: Promise<unknown>): Promise<boolean> {
  let finished = false;
  done.then(
    () => (finished = true),
    () => (finished = true),
  );
  return new Promise((resolve) => {
    const check = (): void => {
      if (currentConfirmDialog()) resolve(true);
      else if (finished) resolve(false);
      else setTimeout(check, 10);
    };
    check();
  });
}
