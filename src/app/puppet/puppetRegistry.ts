import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { getContext, onDestroy, setContext } from 'svelte';

import { TEST_HOOKS_ENABLED } from '../testHooksEnabled';

type PuppetParamType = 'string' | 'integer' | 'boolean';

/** JSON Schema for a verb's arguments — the manifest shape LLM tool APIs consume natively. */
export interface PuppetVerbSchema {
  type: 'object';
  properties: Record<string, { type: PuppetParamType; enum?: string[] }>;
  required: string[];
}

/** The verbs a shortcut argument stands for: `[["SetNewFolderName", {"name": "$"}], ["SubmitNewFolder"]]`. */
export type PuppetShortcutSteps = ReadonlyArray<readonly [string, Record<string, unknown>?]>;

/** The shortcuts the folder flows share, on every platform: the same steps, the same names. */
export const SHORTCUT_STEPS = {
  /** A new-folder dialog's name: type it, press Create. */
  newFolderName: [['SetNewFolderName', { name: '$' }], ['SubmitNewFolder']],
  /** A rename's new name: type it, press Rename (Enter in desktop's inline field). */
  newName: [['SetNewName', { name: '$' }], ['SubmitRename']],
  /** A move's destination: pick it in the folder picker. */
  targetPath: [['PickFolder', { path: '$' }]],
  /** A menu's option: choose it. */
  item: [['$']],
} as const satisfies Record<string, PuppetShortcutSteps>;

/** HTTP-shaped outcome so every shell's listener can relay it without translation. */
export interface PuppetOutcome {
  status: number;
  body: unknown;
}

export interface PuppetVerb {
  name: string;
  schema: PuppetVerbSchema;
  /** A write that is not input a person can produce (puppetFastWrites.ts); omitted for real input. */
  convenience?: true;
  /**
   * An optional argument that does the next steps for the agent: the verbs a person would
   * take after this one, `"$"` standing for the argument's value (in a step's args, or as a
   * step's verb). The CLI runs those steps after this verb, each with its own receipt, so a
   * shortcut never takes a path the app does not. A value-keyed map picks the steps by value.
   */
  shortcuts?: Record<string, PuppetShortcutSteps | Record<string, PuppetShortcutSteps>>;
  /** A promise means the verb is still running; `do` answers 202 and the record settles later. */
  run(args: Args): PuppetOutcome | Promise<PuppetOutcome>;
  /**
   * The catalog keys of the labels of the controls this verb stands for, so a row reads
   * `→ Verb` and `just check-puppet-verbs` holds every labelled control to a verb.
   */
  controls?: readonly string[];
  /**
   * A selector for the controls this verb stands for whose label is the user's own (a note's
   * title, a folder's name), which no catalog key names: `[data-note-id]` for OpenNote.
   */
  controlsMatching?: string;
}

/** What the mounted editor lends the inspector. Closures, so the editor stays the owner. */
export interface PuppetEditorProvider {
  getView(): EditorView | null;
  /** Whether a large note's tail is still streaming in (progressiveLoad.ts). */
  loading(): boolean;
  /** The path of the note the editor holds, null for none. */
  note(): string | null;
  find(): { open: boolean; query: string; current: number; total: number };
  /** The toolbar's commands (toolbarExec.ts), Undo and Redo aside: those are verbs of their own. */
  execIds(): readonly string[];
  exec(commandId: string): void;
  /** Ctrl/Cmd+F: the desktop shell's find bar, which registers its own verbs once open. */
  openFind(): void;
  /** `markdown` parsed the way the editor loads a note: what the fast writes insert. */
  parseMarkdown(markdown: string): ProseNode | null;
  /** `doc` serialized the way the editor saves a note: the markdown `doc` shows beside each line. */
  serialize(doc: ProseNode): string | null;
  /** What a click on the link or wikilink at `pos` does; false when there is none there. */
  openLinkAt(pos: number, newTab: boolean): boolean;
  /** The image picker returned `path`: what the `/` menu's Image item inserts. Absent where nothing picks. */
  insertImage?(path: string): Promise<void>;
}

/** What the surrounding shell lends: which screen this is and its domain state. */
interface PuppetShellProvider {
  screen(): string;
  state(): Record<string, unknown>;
  /**
   * Every note id and folder path in the vault, independent of what the tree is
   * drawing: a collapsed folder hides its whole subtree, so the DOM cannot
   * answer "is it still there?".
   */
  vault?(): { notes: string[]; folders: string[]; modified?: Record<string, number> };
  /** The note ids the app's own search ranks for `query`, best first: the search box's engine. */
  search?(query: string, limit: number): Promise<string[]>;
  /**
   * A promise while the screen is still catching up with what a verb asked for
   * (desktop: a note switch, which saves a dirty note before loading the next),
   * nothing once it has. `do` settles every receipt after it, so a receipt shows
   * where the app landed, not where it was headed. A promise that resolves with a
   * reason means the screen did not get there, and the verb refuses with it.
   */
  settled?(): Promise<string | undefined> | undefined;
}

export const puppetProviders: {
  editor: PuppetEditorProvider | null;
  shell: PuppetShellProvider | null;
} = { editor: null, shell: null };

type VerbProvider = () => PuppetVerb[];

interface Registration {
  provide: VerbProvider;
  /** The modal dialog it was registered in, if any. */
  modal: object | undefined;
  windowShortcuts: boolean;
}
const registrations = new Set<Registration>();

const MODAL_SCOPE = Symbol('puppet modal scope');
/** The modal dialogs open now, in the order they opened: the last one is on top. */
const openModals: object[] = [];

/** The shell names its screen; an embedded editor with no shell is just `editor`. */
export function currentScreen(): string {
  if (puppetProviders.shell) return puppetProviders.shell.screen();
  return puppetProviders.editor?.getView() ? 'editor' : 'unknown';
}

/** The editor is mounted and on screen: the shell's `editor:<id>`, or the phones' shell-less `editor`. */
export function editorOnScreen(): boolean {
  const screen = currentScreen();
  return (
    Boolean(puppetProviders.editor?.getView()) &&
    (screen === 'editor' || screen.startsWith('editor:'))
  );
}

export type Args = Record<string, unknown>;

export const ok = (body: unknown): PuppetOutcome => ({ status: 200, body });

export const puppetRefusal = (status: number, error: string): PuppetOutcome => ({
  status,
  body: { ok: false, error },
});

export function isPuppetOutcome(value: unknown): value is PuppetOutcome {
  return typeof value === 'object' && value !== null && 'status' in value && 'body' in value;
}

/**
 * `'string'` is required, `'string?'` optional, and `'dark|light'` a string that is one of
 * those — the whole schema grammar a verb needs. The values land in the schema, so `actions`
 * shows them and a value outside them is refused before the verb runs.
 */
export type PuppetParams = Record<string, `${PuppetParamType}${'' | '?'}` | `${string}|${string}`>;

function schemaOf(params: PuppetParams): PuppetVerbSchema {
  const properties: PuppetVerbSchema['properties'] = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(params)) {
    const optional = spec.endsWith('?');
    const type = optional ? spec.slice(0, -1) : spec;
    properties[name] = type.includes('|')
      ? { type: 'string', enum: type.split('|') }
      : { type: type as PuppetParamType };
    if (!optional) required.push(name);
  }
  return { type: 'object', properties, required };
}

type VerbResult = PuppetOutcome | undefined | void;

/**
 * A verb next to the handler it drives. `run` returns nothing on success (the
 * receipt is `{ok, verb}`), a refusal to say no, or a promise while the app is
 * still working; a promise's rejection becomes a 500 with the error text.
 */
export function puppetVerb(
  name: string,
  params: PuppetParams,
  run: (args: Args) => VerbResult | Promise<VerbResult>,
  options: Pick<PuppetVerb, 'controls' | 'controlsMatching' | 'convenience' | 'shortcuts'> = {},
): PuppetVerb {
  // Only an outcome is a receipt. A handler that returns its own value (a tab, a note) is
  // reporting to its caller, not to the agent.
  const receipt = (result: VerbResult): PuppetOutcome =>
    isPuppetOutcome(result) ? result : ok({ ok: true, verb: name });
  return {
    name,
    schema: schemaOf(params),
    ...(options.convenience ? { convenience: true } : {}),
    ...(options.controls ? { controls: options.controls } : {}),
    ...(options.controlsMatching ? { controlsMatching: options.controlsMatching } : {}),
    ...(options.shortcuts ? { shortcuts: options.shortcuts } : {}),
    run(args) {
      const result = run(args);
      return result instanceof Promise ? result.then(receipt) : receipt(result);
    },
  };
}

/**
 * Called while a modal dialog's component initializes. It and every component beneath it
 * register their verbs into the dialog, and while it is open those are the only verbs on
 * offer: a person reaches nothing behind a modal (the window's shortcuts aside). No-op in a
 * shipped build.
 */
export function puppetModalScope(): void {
  if (!TEST_HOOKS_ENABLED) return;
  const modal = {};
  setContext(MODAL_SCOPE, modal);
  openModals.push(modal);
  onDestroy(() => openModals.splice(openModals.indexOf(modal), 1));
}

/** The modal dialog the calling component sits in. None outside a component (an editor plugin). */
function enclosingModal(): object | undefined {
  try {
    return getContext<object | undefined>(MODAL_SCOPE);
  } catch {
    return undefined;
  }
}

/**
 * Components register the verbs for the handlers they own while mounted, so
 * `actions` is exactly what is on screen: a modal's verbs exist only while it
 * is open, and hide everything behind it. `windowShortcuts` are the window's own
 * key chords, which work whatever dialog is open. No-op in a shipped build.
 * Returns the unregister.
 */
export function registerPuppetVerbs(
  provide: VerbProvider,
  options: { windowShortcuts?: true } = {},
): () => void {
  if (!TEST_HOOKS_ENABLED) return () => {};
  const registration: Registration = {
    provide,
    modal: enclosingModal(),
    windowShortcuts: options.windowShortcuts === true,
  };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

let copied: { count: number; text: string } | null = null;

/**
 * The app put `text` on the system clipboard. Called where it does, so `state` can say what
 * the app copied without reading the clipboard, which holds whatever the user copied
 * anywhere else. No-op in a shipped build.
 */
export function recordPuppetCopy(text: string): void {
  if (!TEST_HOOKS_ENABLED) return;
  copied = { count: (copied?.count ?? 0) + 1, text };
}

/** What the app last copied, and how many copies it has made. */
export function puppetCopied(): { count: number; text: string } | null {
  return copied;
}

function reachable(registration: Registration): boolean {
  const top = openModals[openModals.length - 1];
  return top === undefined || registration.modal === top || registration.windowShortcuts;
}

function verbsWhere(reached: boolean): PuppetVerb[] {
  return [...registrations]
    .filter((registration) => reachable(registration) === reached)
    .flatMap((registration) => registration.provide());
}

/** The registered verbs a person can reach, in registration order: the top modal's, while one is open. */
export const registeredVerbs = (): PuppetVerb[] => verbsWhere(true);

/** The registered verbs the open modal dialog hides, so a refusal can say why one is missing. */
export const verbsBehindModal = (): PuppetVerb[] => verbsWhere(false);

/** Test seam. */
export function clearPuppetVerbs(): void {
  registrations.clear();
}

/** No-ops in a shipped build: nothing reads the registry there. Returns the unregister. */
export function registerPuppetEditor(provider: PuppetEditorProvider): () => void {
  if (!TEST_HOOKS_ENABLED) return () => {};
  puppetProviders.editor = provider;
  return () => {
    if (puppetProviders.editor === provider) puppetProviders.editor = null;
  };
}

export function registerPuppetShell(provider: PuppetShellProvider): () => void {
  if (!TEST_HOOKS_ENABLED) return () => {};
  puppetProviders.shell = provider;
  return () => {
    if (puppetProviders.shell === provider) puppetProviders.shell = null;
  };
}
