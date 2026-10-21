import { type Editor } from '@milkdown/kit/core';
import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
import { type DocumentRef, type FlushFailureReason } from '@futo-notes/editor';
import { type FindBarState } from './find';

/** The component props the handle reports through. Getters: each read is the CURRENT prop. */
export interface HostHandleProps {
  readonly nativeShell: boolean;
  readonly ondocumentloaded?: (ref: DocumentRef, source: 'load' | 'external') => void;
  readonly onflushfailed?: (ref: DocumentRef, token: string, reason: FlushFailureReason) => void;
  readonly onexternalrefused?: (ref: DocumentRef) => void;
  readonly onfindstate?: (state: FindBarState) => void;
}

export interface HostHandleDeps {
  getEditor: () => Editor | null;
  pmView: () => ProseView | null;
  emitCursorContext: () => void;
  emitFormatState: () => void;
  props: HostHandleProps;
}
