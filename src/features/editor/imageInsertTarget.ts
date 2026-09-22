/*
 * WHO a delayed image completion belongs to.
 *
 * Saving an image is asynchronous and the editor is REUSED across notes: the
 * same component that started a drop, a `/image` pick or a paste in note A is
 * holding note B by the time the bytes land. An insert callback that writes
 * "wherever the editor is now" therefore puts `![](image-…)` into whichever
 * note happens to be open — the user drops a picture on one note and it
 * appears in another (P1, found 2026-09-19 against the mounted editor).
 *
 * The rule is already the spec's, written for the native shells where the host
 * owns the WebView: "A delayed native picker/clipboard completion belongs to
 * the editor attachment generation that started it. Detaching, deleting, or
 * adopting another note invalidates the completion, so it cannot insert
 * Markdown into a different note… It removes a just-saved image when its
 * attachment became stale before insertion." (docs/spec/editor.md, "Images").
 * This states the SAME rule once for the shared editor, and both asynchronous
 * entry points take one of these instead of a bare callback — `imageInsert.ts`
 * (OS drop and the `/image` picker) and `imagePasteSink.ts` (clipboard paste)
 * — so neither can forget the check.
 *
 * The file goes with the reference. A vault blob nothing points at is not a
 * note's content, and leaving it behind would turn every abandoned drop into
 * silent vault litter that no UI lists as removable.
 */

/** A completion bound to one document, produced by {@link ImageInsertTarget.begin}. */
export type CompleteImageInsert = (filename: string) => void;

export interface ImageInsertTarget {
  /**
   * Binds a completion to the document the editor holds RIGHT NOW. Call it
   * BEFORE the asynchronous work starts — a claim taken afterwards is taken
   * against whatever note the user has since opened, which is the bug — and
   * call what it returns with the saved vault filename when the work lands.
   *
   * One claim covers a whole batch: a multi-image drop that switches notes
   * halfway must abandon the images it has not inserted yet, not adopt the
   * new note for them.
   */
  begin(): CompleteImageInsert;
}

export interface ImageInsertTargetOptions {
  /**
   * The document the editor is holding, as any value that CHANGES when it
   * adopts a different note. Compared with `!==`, never interpreted.
   */
  documentToken: () => unknown;
  /** Puts a vault filename into the live document. */
  insert: (filename: string) => void;
  /**
   * Removes an image an abandoned completion had already written into the
   * vault. Omitted where this host cannot delete (a plain browser).
   */
  discard?: (filename: string) => Promise<void>;
  reportError?: (message: string, error: unknown) => void;
}

export function createImageInsertTarget(options: ImageInsertTargetOptions): ImageInsertTarget {
  const { documentToken, insert, discard, reportError = console.error } = options;

  return {
    begin(): CompleteImageInsert {
      const startedOn = documentToken();
      return (filename: string): void => {
        if (documentToken() === startedOn) {
          insert(filename);
          return;
        }
        /* The note this image was for is no longer the one on screen. The
         * reference has nowhere honest to go, so the file it created goes with
         * it — failing to delete is reported and otherwise ignored, because
         * there is nothing further the user could do about it and the note is
         * already safe. */
        void discard?.(filename).catch((error: unknown) =>
          reportError('Abandoned image could not be removed:', error),
        );
      };
    },
  };
}
