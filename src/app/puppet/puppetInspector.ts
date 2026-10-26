/**
 * The puppet inspector: typed verbs and typed queries over the running webview,
 * for `futo-puppet` (crates/futo-puppet). Installed on `window.__futoPuppet` in
 * dev and `VITE_INCLUDE_TEST_HOOKS=true` builds only (see installPuppetInspector.ts).
 *
 * One entry point, `run(command, argsJson)`, returns `{status, body}` so each
 * shell's listener can relay it as an HTTP response without translation.
 *
 * Design record: docs/research/agent-native-app-design.md.
 */
import { lastOpenedUrl } from '../../lib/platform/openExternalUrl';

import { collectElements, elementForRef, ownersOf, stackAt } from './puppetElements';
import { showElement } from './puppetShowElement';
import { clipboard, editorDoc, editorState, showText, lineView } from './puppetEditorReads';
import { editorVerbs } from './puppetEditorVerbs';
import { offsetInLine } from './puppetLines';
import { linesOnScreen, noteLines, shownLines } from './puppetNoteLines';
import { scrollEntries } from './puppetSections';
import {
  puppetCopied,
  puppetProviders,
  puppetRefusal as refuse,
  currentScreen,
  editorOnScreen,
  ok,
  registeredVerbs,
  registerPuppetVerbs,
  verbsBehindModal,
  type Args,
  type PuppetOutcome,
  type PuppetVerb,
  type PuppetVerbSchema,
} from './puppetRegistry';
import {
  actionById,
  beginGesture,
  endGesture,
  eventById,
  eventsSince,
  lastAction,
  lastEventId,
  recordDo,
} from './puppetTrace';
import {
  diffElements,
  diffSnapshots,
  isEmptyDiff,
  snapshotById,
  takeSnapshot,
  type Snapshot,
} from './puppetSnapshots';
import { scrollByVerb } from './puppetScroll';

/** What the previous `elements` answered, so `{"changed":true}` can say what moved since. */
let lastElementsSnapshot: Snapshot | null = null;

function isRecord(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{"index": integer, "noteId": string?}` — `?` is optional. What a wrong argument gets told. */
function argumentList(schema: PuppetVerbSchema): string {
  // As the CLI's `actions` prints them: required first, `?` on an optional name.
  const required = (key: string) => schema.required.includes(key);
  const entries = Object.entries(schema.properties)
    .sort(([a], [b]) => Number(required(b)) - Number(required(a)))
    .map(
      ([key, property]) =>
        `${key}${required(key) ? '' : '?'}: ${property.enum?.join('|') ?? property.type}`,
    );
  return entries.length === 0 ? 'takes no arguments' : `takes {${entries.join(', ')}}`;
}

/**
 * A rejected argument always says what this verb does accept. A guess at a name
 * ("position" where the verb takes "index") otherwise costs a whole round trip
 * through `actions` to learn something the refusal already knew.
 */
function schemaError(schema: PuppetVerbSchema, args: Args): string | null {
  const accepts = argumentList(schema);
  for (const key of schema.required) {
    if (!(key in args)) return `missing required argument "${key}" — ${accepts}`;
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) return `unknown argument "${key}" — ${accepts}`;
    const actual =
      property.type === 'integer'
        ? Number.isInteger(value)
          ? 'integer'
          : typeof value
        : typeof value;
    if (actual !== property.type) return `argument "${key}" must be ${property.type} — ${accepts}`;
    if (property.enum && !property.enum.includes(value as string)) {
      return `argument "${key}" must be one of ${property.enum.join(', ')}, not ${JSON.stringify(value)}`;
    }
  }
  return null;
}

function manifest(): Array<Pick<PuppetVerb, 'name' | 'schema' | 'convenience' | 'shortcuts'>> {
  return registeredVerbs().map((verb) => ({
    name: verb.name,
    schema: verb.schema,
    ...(verb.convenience ? { convenience: true } : {}),
    ...(verb.shortcuts ? { shortcuts: verb.shortcuts } : {}),
  }));
}

function actions(): PuppetOutcome {
  return ok({ screen: currentScreen(), actions: manifest() });
}

/**
 * A verb's outcome, held until the shell has caught up with what the verb asked for; a
 * refusal when the shell says it could not get there.
 */
function settledRun(verb: PuppetVerb, args: Args): PuppetOutcome | Promise<PuppetOutcome> {
  const afterShell = (outcome: PuppetOutcome): PuppetOutcome | Promise<PuppetOutcome> => {
    const settling = outcome.status < 400 ? puppetProviders.shell?.settled?.() : undefined;
    return settling
      ? settling.then((failure) => (failure === undefined ? outcome : refuse(409, failure)))
      : outcome;
  };
  const result = verb.run(args);
  return result instanceof Promise ? result.then(afterShell) : afterShell(result);
}

function doVerb(args: Args): PuppetOutcome {
  const name = args.verb;
  if (typeof name !== 'string') return refuse(400, 'do needs {"verb": string, "args"?: object}');
  const verb = registeredVerbs().find((candidate) => candidate.name === name);
  if (!verb) {
    return refuse(
      404,
      verbsBehindModal().some((candidate) => candidate.name === name)
        ? `${name} is behind the open dialog, which a person closes first`
        : `no such verb on this screen: ${name}`,
    );
  }
  const verbArgs = args.args ?? {};
  if (!isRecord(verbArgs)) return refuse(400, `${name}: args must be a JSON object`);
  const invalid = schemaError(verb.schema, verbArgs);
  if (invalid) return refuse(400, `${name}: ${invalid}`);
  // Bracketed by snapshots: the receipt carries what the verb changed and how many events it caused.
  const { outcome, action } = recordDo(name, verbArgs, () => settledRun(verb, verbArgs));
  if (outcome.status >= 400 || typeof outcome.body !== 'object' || outcome.body === null) {
    return outcome;
  }
  const body = outcome.body as Record<string, unknown>;
  if (action.pending) return { status: 202, body: { ...body, action: action.id } };
  return ok({
    ...body,
    action: action.id,
    ...(action.diff && !isEmptyDiff(action.diff) ? { diff: action.diff } : {}),
    ...(action.changedSinceLast ? { changedSinceLast: action.changedSinceLast } : {}),
    events: action.events[1] - action.events[0],
  });
}

function state(): PuppetOutcome {
  return ok({
    screen: currentScreen(),
    editor: editorState(),
    copied: puppetCopied(),
    opened: lastOpenedUrl(),
    ...(puppetProviders.shell?.state() ?? {}),
  });
}

function elements(args: Args): PuppetOutcome {
  const snapshot = takeSnapshot();
  const viewport = { w: innerWidth, h: innerHeight };
  if (args.changed === true) {
    const previous = lastElementsSnapshot;
    lastElementsSnapshot = snapshot;
    if (!previous) return refuse(409, 'no earlier elements snapshot to compare against');
    return ok({
      snapshot: snapshot.id,
      since: previous.id,
      viewport,
      ...diffElements(previous.elements, snapshot.elements),
    });
  }
  let root: Element | undefined;
  if (typeof args.in === 'string') {
    const found = elementForRef(args.in);
    if (!found) return refuse(404, `no element ${args.in} on the page`);
    root = found;
  }
  lastElementsSnapshot = snapshot;
  const rows =
    args.all === true || root
      ? collectElements({ all: args.all === true, root })
      : snapshot.elements;
  const scroll = scrollEntries(
    rows.map((row) => elementForRef(row.ref)).filter((element) => element !== null),
  );
  return ok({ snapshot: snapshot.id, viewport, elements: rows, scroll });
}

/**
 * Every note id and folder path the vault holds — what the sidebar is showing is
 * a different question. A collapsed folder hides its whole subtree from every
 * DOM query while the verbs that take those ids keep working, and deleting a
 * folder's last note deletes the folder too, so a vanished row means either.
 * `{"modified":true}` adds each note's modification time: what futo-puppet diffs
 * a receipt's vault by.
 */
function notes(args: Args): PuppetOutcome {
  const vault = puppetProviders.shell?.vault?.();
  if (!vault) {
    return refuse(501, 'this shell does not report the vault');
  }
  const { modified, ...ids } = vault;
  return ok(args.modified === true ? { ...ids, modified } : ids);
}

function vaultIds(): Record<string, unknown> {
  const vault = puppetProviders.shell?.vault?.();
  return vault ? { notes: vault.notes, folders: vault.folders } : {};
}

/**
 * The app's own search over titles, bodies, tags and folders, ranked best first — what the
 * search box shows for the same words. A driver starts from what a goal says about a note,
 * which in a large vault is the only way to it that does not list the whole vault.
 */
async function searchNotes(args: Args): Promise<PuppetOutcome> {
  const query = typeof args.query === 'string' ? args.query : '';
  if (!query.trim()) return refuse(400, 'search needs {"query":"…"}');
  const limit = args.limit ?? 10;
  if (!Number.isInteger(limit) || (limit as number) < 1) {
    return refuse(400, 'search: limit must be a positive integer');
  }
  const search = puppetProviders.shell?.search;
  if (!search) return refuse(501, 'this shell does not search yet');
  return ok({ query, hits: await search(query, limit as number) });
}

/**
 * A note's markdown as it is on disk, read once the open note's edits are saved, so they are in
 * it; refused while they are not on disk. `save: false` reads the disk as it is, saving nothing.
 * The CLI narrows it to lines or matches.
 */
async function readFile(args: Args): Promise<PuppetOutcome> {
  const { noteId, save } = args;
  if (typeof noteId !== 'string' || !noteId) return refuse(400, 'file needs {"noteId":"…"}');
  const shell = puppetProviders.shell;
  if (!shell?.saveOpenNote || !shell.readNote) {
    return refuse(501, 'this shell does not read files yet');
  }
  if (save !== false && (await shell.saveOpenNote()).includes(noteId)) {
    return refuse(
      409,
      `${JSON.stringify(noteId)} has edits that did not save, so its file is not what the editor shows; "save":false reads the disk as it is`,
    );
  }
  const text = await shell.readNote(noteId);
  return text === null
    ? refuse(404, `no note ${JSON.stringify(noteId)} in the vault; \`notes\` lists every one`)
    : ok({ noteId, text });
}

/** The commands that answer with a promise: the search engine and the disk are async. */
const asyncCommands = new Map([
  ['search', searchNotes],
  ['file', readFile],
]);

function at(args: Args): PuppetOutcome {
  const { x, y } = args;
  if (typeof x !== 'number' || typeof y !== 'number')
    return refuse(400, 'at needs {"x": number, "y": number}');
  const stack = stackAt(x, y);
  // The pointer shape the user would see here. A cursor bug is otherwise invisible to
  // every query, and a screenshot only shows it after a real mouse move.
  const topmost = document.elementFromPoint(x, y);
  const body: Record<string, unknown> = {
    x,
    y,
    takes: stack[0]?.ref ?? null,
    cursor: topmost ? getComputedStyle(topmost).cursor : null,
    owners: ownersOf(stack),
    stack,
  };
  const view = puppetProviders.editor?.getView();
  if (view && stack.some((row) => row.role === 'editor')) {
    const hit = view.posAtCoords({ left: x, top: y });
    const entry = hit ? noteLines(view.state.doc).at(hit.pos) : null;
    body.editor = hit
      ? {
          pos: hit.pos,
          ...(entry ? { line: entry.line, col: offsetInLine(entry, hit.pos) + 1 } : {}),
        }
      : null;
  }
  return ok(body);
}

function show(args: Args): PuppetOutcome {
  if (typeof args.text === 'string') return showText(args.text);
  if (typeof args.ref !== 'string') return refuse(400, 'show needs {"ref": "eN"} or {"text": "…"}');
  const element = elementForRef(args.ref);
  if (!element) return refuse(404, `no element ${args.ref} on the page`);
  return ok(showElement(element));
}

function events(args: Args): PuppetOutcome {
  if (typeof args.id === 'number') {
    const event = eventById(args.id);
    return event ? ok(event) : refuse(404, `no event ${args.id} in the trace`);
  }
  const since = typeof args.since === 'number' ? args.since : 0;
  return ok({ since, last: lastEventId(), events: eventsSince(since) });
}

function diff(args: Args): PuppetOutcome {
  if (typeof args.from === 'number' || typeof args.to === 'number') {
    const before = typeof args.from === 'number' ? snapshotById(args.from) : undefined;
    // No `to`: against the page as it is now (a batch's screen as it ended, past the last
    // step's own snapshot, which a verb whose rows land after it answers can predate).
    const after = typeof args.to === 'number' ? snapshotById(args.to) : before && takeSnapshot();
    if (!before || !after) return refuse(404, 'diff needs two snapshot ids still in the trace');
    return ok(diffSnapshots(before, after));
  }
  const action = typeof args.action === 'number' ? actionById(args.action) : lastAction();
  if (!action) return refuse(404, 'no action recorded yet');
  return ok(action);
}

/**
 * Real input arrives from outside the page, so the CLI brackets it: `begin`
 * before the gesture, `end` once the events have settled. `end` answers with
 * the action record — diff plus the events in between.
 */
function trace(args: Args): PuppetOutcome {
  if (args.begin === true) return ok(beginGesture());
  if (args.end === true) {
    const action = endGesture();
    if (!action) return refuse(409, 'no gesture begun');
    return ok({
      ...action,
      trace: eventsSince(action.events[0]).filter((event) => event.id <= action.events[1]),
    });
  }
  return refuse(400, 'trace needs {"begin":true} or {"end":true}');
}

/**
 * Everything a one-decision-per-turn controller needs in a single call: the receipt-less
 * view of the app after an action, for `futo-puppet step`. It carries the verbs, the state,
 * the open note's lines on screen, the vault's note ids and folder paths (a collapsed folder
 * draws no rows) and the rows a person can reach, as `elements` lists them.
 */
function observe(): PuppetOutcome {
  const rows = collectElements({});
  const view = puppetProviders.editor?.getView();
  const screen = currentScreen();
  // `editor` with no id is the phones' embed, which has no shell to name a screen and
  // is nothing but an editor: without this its `lines` came back empty and a driver
  // wrote into a document it could not read.
  const editor = puppetProviders.editor;
  const lines =
    view && editor && editorOnScreen()
      ? shownLines(noteLines(view.state.doc), linesOnScreen(view)).map((entry) =>
          lineView(entry, view, editor),
        )
      : [];
  return ok({
    screen,
    editor: editorState(),
    ...(puppetProviders.shell?.state() ?? {}),
    ...vaultIds(),
    actions: manifest(),
    elements: rows.map(({ ref, component, role, text, note, folder }) => ({
      ref,
      component,
      role,
      text,
      ...(note ? { note } : {}),
      ...(folder ? { folder } : {}),
    })),
    lines,
  });
}

const COMMANDS: Record<string, (args: Args) => PuppetOutcome> = {
  actions,
  observe,
  clipboard,
  do: doVerb,
  state,
  notes,
  elements,
  doc: editorDoc,
  at,
  show,
  events,
  diff,
  trace,
};

export function runPuppetCommand(command: string, args: unknown): PuppetOutcome {
  const handler = COMMANDS[command];
  if (!handler) return refuse(404, `no such command: ${command}`);
  if (!isRecord(args)) return refuse(400, `${command}: arguments must be a JSON object`);
  try {
    return handler(args);
  } catch (error) {
    return refuse(
      500,
      `${command} threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The wire form: JSON in, JSON out, so every host bridge can carry it as a string. Only the
 * async commands answer with a promise; the desktop bridge awaits the script, and the phones
 * answer those natively, so no synchronous host ever receives one.
 */
export function runPuppetCommandJson(command: string, argsJson: string): string | Promise<string> {
  let args: unknown;
  try {
    args = argsJson.trim() === '' ? {} : JSON.parse(argsJson);
  } catch {
    return JSON.stringify(refuse(400, `${command}: arguments are not valid JSON`));
  }
  const asyncCommand = asyncCommands.get(command);
  if (asyncCommand && isRecord(args)) {
    return asyncCommand(args).then(
      (outcome) => JSON.stringify(outcome),
      (error: unknown) =>
        JSON.stringify(
          refuse(
            500,
            `${command} threw: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    );
  }
  return JSON.stringify(runPuppetCommand(command, args));
}

/**
 * The editor's verbs register like any surface's, outside every dialog, so a modal hides them;
 * ScrollBy is the window's, like its key chords.
 */
export function installPuppetInspector(): void {
  (window as unknown as { __futoPuppet?: unknown }).__futoPuppet = { run: runPuppetCommandJson };
  registerPuppetVerbs(editorVerbs);
  registerPuppetVerbs(() => [scrollByVerb()], { windowShortcuts: true });
}
