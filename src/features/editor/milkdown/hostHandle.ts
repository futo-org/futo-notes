/*
 * The host handle: every call the embed entry point (src/editor-embed/main.ts,
 * createFutoEditorApi.ts) and the desktop shell (NoteWorkspace.svelte's
 * `EditorApi`) make on the editor. MilkdownEditor.svelte re-exports each one
 * under the same name: these are the component's exports.
 *
 * Grouped by what each call reaches: the note's content (what leaves the
 * editor, and the chrome's edits into it), which note is held, the view, find,
 * and the harness probes no shell calls. The document state they share is the
 * editor's DocumentSession.
 */
import type { DocumentLoad } from './documentLoad';
import type { DocumentSession } from './documentSession.svelte';
import { type SerializationLoop } from './serializationLoop';
import type { HostHandleDeps } from './hostHandleDeps';
import { createContentCommands } from './hostHandleContent';
import { createFindCommands } from './hostHandleFind';
import { createNoteCommands } from './hostHandleNote';
import { createHarnessProbes } from './hostHandleProbes';
import { createViewCommands } from './hostHandleView';
export type { HostHandleDeps, HostHandleProps } from './hostHandleDeps';

/**
 * The editor's host handle. `emitFindState` rides along for the find plugin
 * (editorPlugins.ts); every other member is one of the component's exports.
 */
export function createHostHandle(
  session: DocumentSession,
  serialization: SerializationLoop,
  documentLoad: DocumentLoad,
  deps: HostHandleDeps,
) {
  const view = createViewCommands(deps);
  const content = createContentCommands(session, serialization, documentLoad, deps);
  return {
    ...createNoteCommands(session, serialization, documentLoad, deps, {
      flush: content.flush,
      resetHistory: view.resetHistory,
    }),
    ...content,
    ...view,
    ...createFindCommands(deps),
    ...createHarnessProbes(session, serialization, documentLoad, deps),
  };
}
