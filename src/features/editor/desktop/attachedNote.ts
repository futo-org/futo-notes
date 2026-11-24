/* One note attached to the desktop host (apps/tauri/src-tauri/src/editor_host.rs,
 * docs/architecture/text-first-editor-desktop-host.md): the page's engine, the
 * requests that mirror its edits to the host's worker, and what the worker reports
 * back. The page shows every edit at once; typing never waits on a reply. */
import type { Applied, HostAck, HostRequest, NoteIdChange } from '@futo-notes/editor/wasm-payloads';
import type { LocalNoteMutation } from '$lib/localNoteStore';
import { noteEditorHost } from '$lib/platform';
import type {
  EditorOpened,
  EditorOutcome,
  EditorSaved,
  EditorSwitched,
} from '$lib/platform/tauri/editorHost';
import { Engine, type AdoptionRefusal } from './engine';

type Host = Awaited<ReturnType<typeof noteEditorHost>>;

/** What one outcome of the host's worker changed. */
export interface Landed {
  /** Apply before anything reads the notes again (null: nothing changed on disk). */
  mutation: LocalNoteMutation | null;
  /** The note the attachment held, and holds now: a rename's final id, the copy a park
   *  left the draft in (`keepsOriginal`: the original keeps its bytes), or where a store
   *  workflow moved it (a move, a sync relocation, a rename the file watcher saw). */
  fromId: string;
  toId: string;
  keepsOriginal: boolean;
  /** The draft reached disk. */
  saved: boolean;
  /** The save recreated the note after it was deleted outside the app. */
  recreated: boolean;
}

export interface AttachedNoteEvents {
  landed(landed: Landed): void;
  /** A save left the note holding `source`, an outside change, instead of the draft it
   *  saved: adopt it into the draft now, or say why not (`refused`: the editor re-opens the
   *  note, which already holds both sides). */
  offered(source: string, engine: Engine): Applied | AdoptionRefusal;
  /** The host's timed save failed; it retries, so input carries on. */
  saveFailed(message: string): void;
  /** The note was deleted under the editor; every later request fails. */
  deleted(): void;
}

/* Every `editor:saved` event, by token, through one listener registered before the first
 * command: an event that beats the reply opening its note waits here, and a note's last
 * events still reach it after it was released. */
const receivers = new Map<number, (saved: EditorSaved) => void>();
const early = new Map<number, EditorSaved[]>();
let listening: Promise<unknown> | undefined;

function listen(host: Host): Promise<unknown> {
  listening ??= host.onEditorSaved((saved) => {
    const receive = receivers.get(saved.token);
    if (receive) receive(saved);
    else early.set(saved.token, [...(early.get(saved.token) ?? []), saved]);
  });
  return listening;
}

export class AttachedNote {
  readonly token: number;
  noteId: string;
  /** The source the note held when the draft last matched it: the open snapshot's, then
   *  every save that landed with no edit after it, converged ones included. */
  savedSource: string;
  private savedRevision: number;
  /** The worker numbers this attachment's outcomes 1, 2, …; each is applied in that
   *  order, once, whether it came as an event or a command's reply. */
  private nextStamp = 1;
  private readonly arrived = new Map<number, EditorOutcome>();
  private readonly waiting: Array<{ stamp: number; applied: () => void }> = [];
  /** The stamp of the release's outcome, once released. */
  private lastStamp: number | null = null;
  private pending = 0;
  private resuming = false;
  /** An offer waits for composition to end; the next save offers it again. */
  offerWaiting = false;

  private constructor(
    opened: EditorOpened,
    readonly engine: Engine,
    private readonly host: Host,
    private readonly events: AttachedNoteEvents,
  ) {
    this.token = opened.token;
    this.noteId = opened.noteId;
    this.savedSource = opened.snapshot.source;
    this.savedRevision = opened.snapshot.revision;
  }

  /** Attach `noteId`, then release `previous` (saved, or with `discard` dropped); the
   *  note the host already holds is read back from disk instead. A rejection leaves
   *  `previous` attached. */
  static async open(
    previous: AttachedNote | null,
    noteId: string,
    discard: boolean,
    events: AttachedNoteEvents,
  ): Promise<AttachedNote> {
    const host = await noteEditorHost();
    await listen(host);
    return AttachedNote.attach(host, await host.editorSwitch(noteId, discard), previous, events);
  }

  /** Save `previous`, then read the note its host holds back from disk (an outside change
   *  adopted): the host names the note, never the page. */
  static async reload(previous: AttachedNote, events: AttachedNoteEvents): Promise<AttachedNote> {
    const host = await noteEditorHost();
    await listen(host);
    return AttachedNote.attach(host, await host.editorReload(previous.token), previous, events);
  }

  private static async attach(
    host: Host,
    { opened, closed }: EditorSwitched,
    previous: AttachedNote | null,
    events: AttachedNoteEvents,
  ): Promise<AttachedNote> {
    // Its outcomes still in flight are applied as they arrive; nothing waits on them.
    void previous?.released(closed);
    // The note's wikilinks resolve against the vault's note ids from the first draw.
    const [engine, noteIds] = await Promise.all([
      Engine.restore(opened.snapshot),
      host.editorNoteIds().catch((error: unknown) => {
        console.warn('note ids unread, wikilinks show unresolved:', error);
        return [];
      }),
    ]);
    engine.updateNoteIds(noteIds);
    const note = new AttachedNote(opened, engine, host, events);
    receivers.set(note.token, (saved) => note.hostSaved(saved));
    for (const saved of early.get(note.token) ?? []) note.hostSaved(saved);
    early.delete(note.token);
    return note;
  }

  /** Still attached: not released by a close or a switch. */
  get attached(): boolean {
    return this.lastStamp === null;
  }

  /** Edits not yet acknowledged, or acknowledged but not yet written. */
  get idle(): boolean {
    return this.pending === 0 && this.savedRevision >= this.engine.revision;
  }

  /** Mirror an edit the view already shows. */
  send(applied: Applied): void {
    this.request(applied.request);
  }

  private request(request: HostRequest): void {
    this.pending++;
    this.host.editorRequest(this.token, request).then(
      (ack) => {
        this.pending--;
        this.acknowledged(ack, request.operation === 'Resume');
      },
      (error: unknown) => {
        this.pending--;
        console.warn('editor request failed:', error);
      },
    );
  }

  private acknowledged(ack: HostAck, toResume: boolean): void {
    if (!this.attached) return;
    if (toResume) this.resuming = false;
    let resend: HostRequest[] = [];
    try {
      resend = this.engine.acknowledge(ack);
    } catch (error) {
      console.warn('editor acknowledgement refused:', error);
    }
    for (const request of resend) this.request(request);
    if (ack.error?.kind === 'Deleted') {
      this.events.deleted();
    } else if ((ack.error || ack.paused) && !toResume && !this.resuming) {
      // One resume re-sends what the worker lacks; a refused resume leaves the
      // page paused with its draft copyable.
      this.resuming = true;
      this.request(this.engine.resume());
    }
  }

  private hostSaved({ outcome }: EditorSaved): void {
    void this.arrive(outcome);
  }

  /* Tauri orders the worker's events against the command replies in no way, so an
   * outcome waits for every earlier one. Settles once `outcome` has been applied. */
  private arrive(outcome: EditorOutcome): Promise<void> {
    this.arrived.set(outcome.stamp, outcome);
    for (
      let next = this.arrived.get(this.nextStamp);
      next;
      next = this.arrived.get(this.nextStamp)
    ) {
      this.arrived.delete(this.nextStamp);
      this.nextStamp++;
      this.landed(next);
    }
    for (const waiter of this.waiting.filter(({ stamp }) => stamp < this.nextStamp)) {
      this.waiting.splice(this.waiting.indexOf(waiter), 1);
      waiter.applied();
    }
    if (this.lastStamp !== null && this.nextStamp > this.lastStamp) receivers.delete(this.token);
    if (outcome.stamp < this.nextStamp) return Promise.resolve();
    return new Promise((applied) => this.waiting.push({ stamp: outcome.stamp, applied }));
  }

  /* The attachment is the one owner of which note it holds. */
  private landed(outcome: EditorOutcome): void {
    const current = this.attached && outcome.revision === this.engine.revision;
    if (outcome.saved && outcome.revision >= this.savedRevision) {
      // An offer the draft moved past is never adopted: it would undo the newer typing,
      // and that typing's save merges and offers again.
      if (outcome.offered !== null) {
        if (current) this.takeOffered(outcome.offered, outcome.revision);
      } else {
        this.savedRevision = outcome.revision;
        // An edit after the saved revision is not on disk: the draft is not what it wrote.
        if (current) this.savedSource = this.engine.draftText();
      }
    }
    const fromId = this.noteId;
    this.noteId = outcome.noteId;
    this.events.landed({
      mutation: outcome.mutation,
      fromId,
      toId: this.noteId,
      keepsOriginal: outcome.parked,
      saved: outcome.saved,
      recreated: outcome.recreated,
    });
    if (outcome.error !== null) this.events.saveFailed(outcome.error);
  }

  /* An offer equal to the draft is already held: the engine would refuse it as it refuses
   * one it cannot rebase, and that must never re-open the note. */
  private takeOffered(offered: string, revision: number): void {
    this.offerWaiting = false;
    if (offered === this.engine.draftText()) {
      this.savedRevision = revision;
      this.savedSource = offered;
      return;
    }
    const adopted = this.events.offered(offered, this.engine);
    if (adopted === 'later') this.offerWaiting = true;
    if (typeof adopted === 'string') return;
    this.send(adopted);
    this.savedSource = offered;
    this.savedRevision = this.engine.revision;
  }

  /** Write the Markdown now. Rejects when the save fails; input carries on. Settles with
   *  its outcome once that, and every one before it, has been applied. */
  async checkpoint(): Promise<EditorOutcome> {
    const outcome = await this.host.editorCheckpoint(this.token);
    await this.arrive(outcome);
    return outcome;
  }

  /** Save the draft as `title` in the note's own folder in one store workflow; a park
   *  lands there too, and the attachment follows whichever note now holds the draft. */
  async rename(title: string): Promise<void> {
    await this.arrive(await this.host.editorRename(this.token, title));
  }

  /** Save (or with `discard` drop) the draft, then release the note. A failed save
   *  rejects and leaves it attached. */
  async close(discard: boolean): Promise<void> {
    await this.released(await this.host.editorClose(this.token, discard));
  }

  /* The release's outcome is this attachment's last: it stays listening until every
   * outcome up to it has been applied. */
  private released(outcome: EditorOutcome | null): Promise<void> {
    this.lastStamp = outcome?.stamp ?? 0;
    this.engine.free();
    if (!outcome) {
      receivers.delete(this.token);
      return Promise.resolve();
    }
    return this.arrive(outcome);
  }

  /** Re-read the vault's note ids after the vault changed: what that changed, null once
   *  released. */
  async refreshNoteIds(): Promise<NoteIdChange | null> {
    const ids = await this.host.editorNoteIds();
    return this.attached ? this.engine.updateNoteIds(ids) : null;
  }
}
