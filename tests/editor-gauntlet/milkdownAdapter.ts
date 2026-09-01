import type { Browser, BrowserContext, Page } from '@playwright/test';

import type { DecoratedRange, DriverState } from './driver/protocol';
import { EDITOR_URL } from '../editorEmbedBundle';
import { installFakeAndroidHost, type FakeHostWindow } from '../lib/editorEmbedHost';
import { resolveSourceOffset } from './sourcePositions';
import type {
  EditorGauntletAdapter,
  EditorIntentAction,
  EditorSnapshot,
  KeystrokeMeasurement,
  OpenMeasurement,
  RichTextPoint,
  SourceSelection,
} from './types';

/**
 * The Milkdown implementation of `EditorGauntletAdapter`.
 *
 * It drives the SAME single-file `editor.html` the native shells ship, over
 * `file://`, with the fake native host the editor-embed specs use. That is
 * where Milkdown actually lives during the transition — the desktop Svelte
 * shell is still CodeMirror (docs/plan/milkdown-transition.md D9), so an
 * app-shell adapter like `cm6Adapter` would be testing an engine the app does
 * not run yet.
 *
 * Three things the CodeMirror adapter gets for free and this one has to build:
 *
 * - **Positions.** The runners speak markdown source offsets. Milkdown's
 *   document has no such coordinate, so `sourcePositions.ts` translates an
 *   offset into (top-level block, visible-character offset) and this adapter
 *   resolves that against the live ProseMirror doc. Split-torture cases carry a
 *   `rich` text anchor and use that instead — it is exact.
 * - **The shell and the file.** The embed has no note store. The fake host
 *   plays the part the native shells play: it holds the note, updates its copy
 *   from every debounced `change`, and writes that copy on save. `savedSource`
 *   is therefore the bytes a real shell's autosave would have written.
 * - **Decorations.** `checkSemanticIntent` asks which text carries which
 *   semantic kind. CodeMirror answers from its driver's decoration
 *   set; here the rendered ProseMirror DOM is the answer.
 */

/** Milkdown's own change notification is debounced by @milkdown/plugin-listener. */
const CHANGE_DEBOUNCE_MS = 200;
/** Debounce plus slack, after which a missing `change` is a real finding. */
const CHANGE_FLUSH_MS = CHANGE_DEBOUNCE_MS + 300;

interface GauntletPageState {
  /** Captured while the selection is still ProseMirror's post-load TextSelection. */
  TextSelection: {
    create(doc: unknown, anchor: number, head: number): unknown;
  };
}

type MilkdownWindow = FakeHostWindow & {
  __futoProseMirrorView?: () => ProseViewLike | null;
  __gauntlet?: GauntletPageState;
};

/** The slice of the ProseMirror view surface this adapter uses, in-page. */
interface ProseViewLike {
  state: {
    doc: ProseNodeLike;
    tr: ProseTransactionLike;
    selection: { constructor: unknown; from: number; to: number };
  };
  dispatch(tr: unknown): void;
  focus(): void;
  posAtDOM(node: Node, offset: number): number;
  nodeDOM(pos: number): Node | null;
  dom: HTMLElement;
}

interface ProseNodeLike {
  childCount: number;
  content: { size: number };
  nodeSize: number;
  isText: boolean;
  isLeaf: boolean;
  isAtom: boolean;
  text?: string;
  child(index: number): ProseNodeLike;
  resolve(pos: number): unknown;
  nodesBetween(
    from: number,
    to: number,
    callback: (node: ProseNodeLike, pos: number) => boolean | void,
  ): void;
}

interface ProseTransactionLike {
  setSelection(selection: unknown): ProseTransactionLike;
  insertText(text: string, from?: number, to?: number): ProseTransactionLike;
}

/**
 * A caret target expressed the way the candidate can resolve it: either the nth
 * rendered character of the nth top-level block (from a markdown source
 * offset), or an offset into a named run of rendered text (from a case's
 * `rich` anchor, which is exact).
 */
type CaretPoint =
  | { kind: 'block'; blockIndex: number; textOffset: number }
  | { kind: 'text'; text: string; offset: number; atom?: 'before' | 'after' };

export class MilkdownGauntletAdapter implements EditorGauntletAdapter {
  readonly name = 'milkdown';
  private context: BrowserContext | null = null;
  /** Exposed so a red-proof spec can reach the page it is driving. */
  private livePage: Page | null = null;
  private pageErrors: string[] = [];
  private consoleErrors: string[] = [];
  private openedSource = '';
  /** What the fake host has on "disk"; a real shell's autosaved bytes. */
  private persistedSource = '';
  /** Change notifications already folded into `persistedSource`. */
  private consumedChanges = 0;

  constructor(private readonly browser: Browser) {}

  /** Playwright context teardown; the specs own the lifetime. */
  async dispose(): Promise<void> {
    await this.context?.close();
    this.context = null;
    this.livePage = null;
  }

  async open(source: string, _caseId: string): Promise<void> {
    const page = await this.ensurePage();
    this.pageErrors = [];
    this.consoleErrors = [];
    await page.evaluate(async (markdown) => {
      const testWindow = window as unknown as MilkdownWindow;
      testWindow.FutoEditor.setContent(markdown);
      const view = testWindow.__futoProseMirrorView?.();
      if (!view) throw new Error('milkdown gauntlet: no ProseMirror view');
      // Right after a load the selection is ProseMirror's default TextSelection,
      // which is the only moment its class can be read off an instance without
      // guessing. Everything later reuses this.
      const TextSelection = view.state.selection.constructor as GauntletPageState['TextSelection'];
      if (typeof TextSelection.create !== 'function') {
        throw new Error('milkdown gauntlet: post-load selection is not a TextSelection');
      }
      testWindow.__gauntlet = { TextSelection };
      testWindow.__msgs.length = 0;
    }, source);
    this.openedSource = source;
    this.persistedSource = source;
    this.consumedChanges = 0;
    await this.waitForTwoFrames();
  }

  async select(selection: SourceSelection): Promise<void> {
    const anchor = this.resolvePoint(selection.anchor, selection.rich?.anchor);
    const head = this.resolvePoint(
      selection.head ?? selection.anchor,
      selection.rich?.head ?? selection.rich?.anchor,
    );
    await this.requirePage().evaluate(
      ({ anchor: anchorPoint, head: headPoint }) => {
        const testWindow = window as unknown as MilkdownWindow;
        const view = testWindow.__futoProseMirrorView?.();
        const gauntlet = testWindow.__gauntlet;
        if (!view || !gauntlet) throw new Error('milkdown gauntlet: editor is not open');
        const doc = view.state.doc;

        /**
         * The document's rendered text between two positions, as runs.
         *
         * A run's TEXT LENGTH and its POSITION SPAN are not the same number,
         * and conflating them is the whole difficulty here. A text node of ten
         * characters spans ten positions; a wikilink chip renders ten
         * characters ("alpha beta", from its attrs, through a node view) and
         * spans exactly ONE. Counting its rendered text as positions put every
         * caret after it nine places too far right, which showed up as a paste
         * swallowing the rest of the line rather than as an error.
         *
         * Reading the atom's DOM is still necessary: without it the construct
         * is invisible here and every case anchored to its text dies as a
         * harness failure instead of producing a measurement.
         */
        const runs = (from: number, to: number): Run[] => {
          const collected: Run[] = [];
          if (to <= from) return collected;
          doc.nodesBetween(from, to, (node, pos) => {
            if (node.isText) {
              collected.push({ pos, text: node.text ?? '', span: node.nodeSize, atom: false });
            } else if (node.isLeaf) {
              // A non-atom leaf is a line break: one character, one position.
              const dom = node.isAtom ? view.nodeDOM(pos) : null;
              const text = dom?.textContent || '\n';
              collected.push({ pos, text, span: node.nodeSize, atom: Boolean(dom) });
            }
            return !node.isLeaf;
          });
          return collected;
        };

        /**
         * The position `offset` rendered characters into a run list.
         *
         * Two rules earn their place:
         *
         * - An offset landing exactly on a run boundary resolves to the START
         *   of the FOLLOWING run. Inside a paragraph those are the same
         *   position; across a paragraph break they are not, and "the caret at
         *   the start of the second paragraph" is what a case asking to
         *   backspace two blocks together means. Taking the earlier one put the
         *   caret at the end of the first paragraph, where backspace deletes a
         *   letter instead.
         * - An offset landing INSIDE an atom resolves to one of its edges,
         *   because an atom has no inside to put a caret in. `atomSide` picks
         *   which; "before" is the default. A case that asked to split the
         *   construct in half has no answer in this editor, and an edge is the
         *   honest place to record what it does instead.
         */
        const positionInRuns = (
          collected: Run[],
          offset: number,
          fallback: number,
          atomSide?: 'before' | 'after',
        ): number => {
          let remaining = offset;
          for (const [index, run] of collected.entries()) {
            const isLast = index === collected.length - 1;
            if (remaining < run.text.length || (isLast && remaining === run.text.length)) {
              if (!run.atom) return run.pos + remaining;
              if (remaining === 0) return run.pos;
              return atomSide === 'after' || remaining >= run.text.length
                ? run.pos + run.span
                : run.pos;
            }
            remaining -= run.text.length;
          }
          return fallback;
        };

        const positionFor = (point: typeof anchorPoint): number => {
          let resolved: number;
          if (point.kind === 'text') {
            // A text anchor means "this many characters into this rendered
            // text". Resolving it against the MARKDOWN would have to guess
            // which characters are syntax, and guesses wrong exactly where the
            // matrix is hardest — `[[alpha]]` is a wikilink to us and a
            // bracketed link label to a CommonMark parser.
            const collected = runs(0, doc.content.size);
            const whole = collected.map((run) => run.text).join('');
            const found = whole.indexOf(point.text);
            if (found < 0) {
              throw new Error(`milkdown gauntlet: rendered text lacks the anchor: ${point.text}`);
            }
            resolved = positionInRuns(
              collected,
              found + point.offset,
              doc.content.size,
              point.atom,
            );
          } else {
            if (doc.childCount === 0) return 0;
            const index = Math.max(0, Math.min(point.blockIndex, doc.childCount - 1));
            let base = 0;
            for (let child = 0; child < index; child += 1) base += doc.child(child).nodeSize;
            const block = doc.child(index);
            const contentFrom = base + 1;
            const contentTo = base + block.nodeSize - 1;
            if (contentTo <= contentFrom) return contentFrom;
            resolved = positionInRuns(runs(contentFrom, contentTo), point.textOffset, contentTo);
          }
          return Math.min(Math.max(resolved, 1), doc.content.size);
        };

        const anchorPos = positionFor(anchorPoint);
        const headPos = positionFor(headPoint);
        view.dispatch(
          view.state.tr.setSelection(
            gauntlet.TextSelection.create(view.state.doc, anchorPos, headPos),
          ),
        );
        view.focus();
      },
      { anchor, head },
    );
  }

  async perform(action: EditorIntentAction): Promise<EditorSnapshot[]> {
    const page = this.requirePage();
    switch (action.type) {
      case 'enter':
        await page.keyboard.press('Enter');
        break;
      case 'backspace':
        await page.keyboard.press('Backspace');
        break;
      case 'insert-text':
        await page.keyboard.insertText(action.text);
        break;
      case 'paste':
        await page.locator('.ProseMirror').evaluate((content, text) => {
          const transfer = new DataTransfer();
          transfer.setData('text/plain', text);
          content.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        }, action.text);
        break;
    }

    const observations = [await this.snapshot()];
    await this.waitForTwoFrames();
    observations.push(await this.snapshot());
    return observations;
  }

  /**
   * Flush the shell's pending change, then snapshot.
   *
   * `refused` means what it means for CodeMirror — the edit did not become
   * saveable — but the shape is different here, and getting it wrong makes the
   * sweep's "never refuse" line unfalsifiable. There is no throwing save path
   * to catch: the embed's only route from an edit to the file is the debounced
   * `change` post. So a refusal is exactly that route failing — no new change
   * arrived, and the editor is holding content the shell has never been told
   * about. That is the #105 debounce risk, and it is silent otherwise: the
   * sweep would compare the note against an unchanged file and see no loss.
   */
  async save(): Promise<EditorSnapshot> {
    const delivered = await this.flushChange();
    const content = await this.readContent();
    const refused = !delivered && content !== this.persistedSource;
    return this.snapshot(refused);
  }

  async undo(): Promise<EditorSnapshot> {
    await this.requirePage().keyboard.press('ControlOrMeta+z');
    await this.waitForTwoFrames();
    return this.save();
  }

  async walkCaret(positions: number[]): Promise<void> {
    for (const position of positions) {
      await this.select({ anchor: position });
      await this.requirePage().evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
  }

  async measureOpen(source: string): Promise<OpenMeasurement> {
    const measurement = await this.requirePage().evaluate(async (markdown) => {
      const testWindow = window as unknown as MilkdownWindow;
      const startedAt = performance.now();
      testWindow.FutoEditor.setContent(markdown);
      const synchronousMs = performance.now() - startedAt;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return { synchronousMs, settledMs: performance.now() - startedAt };
    }, source);
    this.openedSource = source;
    this.persistedSource = source;
    this.consumedChanges = 0;
    return {
      bytes: new TextEncoder().encode(source).length,
      lines: source.split('\n').length,
      ...measurement,
    };
  }

  /**
   * Times the SAME unit `cm6Adapter` times: one editor transaction, measured
   * synchronously in the page. Real key presses would fold in Playwright's
   * round trip and the browser's own input handling, which the 16 ms budget
   * was never written against.
   */
  async measureKeystrokes(count: number): Promise<KeystrokeMeasurement> {
    return this.requirePage().evaluate(async (sampleCount) => {
      const testWindow = window as unknown as MilkdownWindow;
      const view = testWindow.__futoProseMirrorView?.();
      if (!view) throw new Error('milkdown gauntlet: no ProseMirror view');
      const synchronousSamplesMs: number[] = [];
      const settledToPaintSamplesMs: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const startedAt = performance.now();
        view.dispatch(view.state.tr.insertText('x'));
        synchronousSamplesMs.push(performance.now() - startedAt);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        settledToPaintSamplesMs.push(performance.now() - startedAt);
      }
      return { synchronousSamplesMs, settledToPaintSamplesMs };
    }, count);
  }

  async captureFeelState(): Promise<DriverState> {
    return this.readDriverState();
  }

  // ---- internals --------------------------------------------------------- //

  private async ensurePage(): Promise<Page> {
    if (this.livePage) return this.livePage;
    const context = await this.browser.newContext({ hasTouch: true });
    await context.addInitScript(installFakeAndroidHost);
    const page = await context.newPage();
    page.on('pageerror', (error) => this.pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') this.consoleErrors.push(message.text());
    });
    await page.goto(EDITOR_URL);
    await page.waitForFunction(() =>
      (window as unknown as MilkdownWindow).__msgs?.some((message) => message.type === 'ready'),
    );
    await page.waitForFunction(() =>
      Boolean((window as unknown as MilkdownWindow).__futoProseMirrorView?.()),
    );
    this.context = context;
    this.livePage = page;
    return page;
  }

  /** The live page, for a spec that needs to reach past the adapter's surface. */
  get page(): Page {
    return this.requirePage();
  }

  private requirePage(): Page {
    if (!this.livePage) throw new Error('milkdown gauntlet: open() has not run yet');
    return this.livePage;
  }

  private waitForTwoFrames(): Promise<void> {
    return this.requirePage().evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
  }

  /**
   * Waits out the listener debounce so the host has the edit before the note is
   * "written". A shell that never hears about an edit and a shell that hears a
   * wrong one are the same bug to the person whose note it is, so a timeout
   * here is not an error — the stale `shellSource` it produces is the finding.
   */
  private async flushChange(): Promise<boolean> {
    const page = this.requirePage();
    // Wait for a change NEWER than the one already on disk. Waiting for "any
    // change" makes every save after the first return instantly with the
    // previous edit's bytes — which is what made undo look like it had not
    // reached the shell.
    await page
      .waitForFunction(
        (consumed) =>
          (window as unknown as MilkdownWindow).__msgs.filter(
            (message) => message.type === 'change',
          ).length > consumed,
        this.consumedChanges,
        { timeout: CHANGE_FLUSH_MS },
      )
      .catch(() => undefined);
    const changes = await page.evaluate(() =>
      (window as unknown as MilkdownWindow).__msgs
        .filter((message) => message.type === 'change')
        .map((message) => message.content as string),
    );
    if (changes.length <= this.consumedChanges) return false;
    this.persistedSource = changes[changes.length - 1]!;
    this.consumedChanges = changes.length;
    return true;
  }

  private resolvePoint(offset: number, rich?: RichTextPoint): CaretPoint {
    if (rich) {
      return { kind: 'text', text: rich.text, offset: rich.offset, atom: rich.atomBoundary };
    }
    return { kind: 'block', ...resolveSourceOffset(this.openedSource, offset) };
  }

  private readContent(): Promise<string> {
    return this.requirePage().evaluate(() =>
      (window as unknown as MilkdownWindow).FutoEditor.getContent(),
    );
  }

  private async snapshot(refused = false): Promise<EditorSnapshot> {
    const page = this.requirePage();
    const [driverState, content, shellSource] = await Promise.all([
      this.readDriverState(),
      this.readContent(),
      page.evaluate(() => {
        const changes = (window as unknown as MilkdownWindow).__msgs.filter(
          (message) => message.type === 'change',
        );
        return (changes.at(-1)?.content as string | undefined) ?? null;
      }),
    ]);
    return {
      source: content,
      shellSource: shellSource ?? this.openedSource,
      savedSource: this.persistedSource,
      visibleText: driverState.visibleText,
      decorations: driverState.decorations,
      warnings: [...this.pageErrors, ...this.consoleErrors],
      refused,
      mode: 'rich',
    };
  }

  /**
   * The `DriverState` shape (driver/protocol.ts), read off the rendered
   * ProseMirror DOM.
   * `doc` is the markdown the editor would save; `decorations` are the semantic
   * spans `checkSemanticIntent` looks for, keyed by the HTML the schema emits.
   */
  private async readDriverState(): Promise<DriverState> {
    const page = this.requirePage();
    return page.evaluate(() => {
      const testWindow = window as unknown as MilkdownWindow;
      const root = document.querySelector('.ProseMirror');
      if (!root) throw new Error('milkdown gauntlet: no .ProseMirror root');
      const view = testWindow.__futoProseMirrorView?.();

      const KIND_FOR_SELECTOR: Array<[string, DecoratedRange['kind']]> = [
        ['strong', 'bold-text'],
        ['em', 'italic-text'],
        ['del', 'strikethrough-text'],
        ['s', 'strikethrough-text'],
        ['a', 'link-text'],
        ['h1', 'heading-text-1'],
        ['h2', 'heading-text-2'],
        ['h3', 'heading-text-3'],
        ['h4', 'heading-text-4'],
        ['h5', 'heading-text-5'],
        ['h6', 'heading-text-6'],
        ['blockquote', 'quote-text'],
        ['img', 'image-widget'],
        ['hr', 'hr-widget'],
        ['table', 'table-widget'],
      ];

      const decorations: DecoratedRange[] = [];
      /**
       * ProseMirror positions are absolute document offsets, which is the
       * `pos` field the protocol says to use "when line/ch is ambiguous" — and
       * in a node tree line/ch is not merely ambiguous, it does not exist.
       * Those two stay 0 and every consumer here reads `pos`.
       */
      const at = (element: Element, side: 0 | 1): DecoratedRange['from'] => {
        let pos = 0;
        try {
          pos = view?.posAtDOM(element, side) ?? 0;
        } catch {
          pos = 0;
        }
        return { line: 0, ch: 0, pos };
      };
      const push = (element: Element, kind: DecoratedRange['kind']): void => {
        decorations.push({
          from: at(element, 0),
          to: at(element, 1),
          kind,
          replaced: false,
          classes: Array.from(element.classList),
          text: element.textContent ?? '',
        });
      };
      for (const [selector, kind] of KIND_FOR_SELECTOR) {
        for (const element of Array.from(root.querySelectorAll(selector))) push(element, kind);
      }
      // Inline code only: a fenced block renders as <pre><code>.
      for (const element of Array.from(root.querySelectorAll('code'))) {
        push(element, element.closest('pre') ? 'code-block' : 'code-inline');
      }

      const selection = view?.state.selection;
      const point = (pos: number) => ({ line: 0, ch: 0, pos });
      return {
        doc: testWindow.FutoEditor.getContent(),
        cursor: point(selection?.from ?? 0),
        selection: { anchor: point(selection?.from ?? 0), head: point(selection?.to ?? 0) },
        decorations,
        visibleText: (root as HTMLElement).innerText,
      };
    });
  }
}
