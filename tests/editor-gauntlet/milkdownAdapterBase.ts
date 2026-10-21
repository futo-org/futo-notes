import type { Browser, BrowserContext, Page } from '@playwright/test';

import type { DecoratedRange, DriverState } from './driverProtocol';
import { EDITOR_URL } from '../editorEmbedBundle';
import { installFakeAndroidHost } from '../lib/editorEmbedHost';
import { resolveSourceOffset } from './sourcePositions';
import type { EditorSnapshot, RichTextPoint } from './types';
import { CHANGE_FLUSH_MS, type CaretPoint, type MilkdownWindow } from './milkdownAdapterTypes';

/**
 * The page, host and in-page-read plumbing of `MilkdownGauntletAdapter`, moved
 * here verbatim from milkdownAdapter.ts so the adapter file holds only the
 * `EditorGauntletAdapter` surface the runners call.
 */
export abstract class MilkdownAdapterBase {
  protected context: BrowserContext | null = null;
  /** Exposed so a red-proof spec can reach the page it is driving. */
  protected livePage: Page | null = null;
  protected pageErrors: string[] = [];
  protected consoleErrors: string[] = [];
  protected openedSource = '';
  /** What the fake host has on "disk"; a real shell's autosaved bytes. */
  protected persistedSource = '';
  /** Change notifications already folded into `persistedSource`. */
  protected consumedChanges = 0;

  constructor(protected readonly browser: Browser) {}

  protected async ensurePage(): Promise<Page> {
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

  protected requirePage(): Page {
    if (!this.livePage) throw new Error('milkdown gauntlet: open() has not run yet');
    return this.livePage;
  }

  protected waitForTwoFrames(): Promise<void> {
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
  protected async flushChange(): Promise<boolean> {
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

  protected resolvePoint(offset: number, rich?: RichTextPoint): CaretPoint {
    if (rich) {
      return { kind: 'text', text: rich.text, offset: rich.offset, atom: rich.atomBoundary };
    }
    return { kind: 'block', ...resolveSourceOffset(this.openedSource, offset) };
  }

  protected readContent(): Promise<string> {
    return this.requirePage().evaluate(() =>
      (window as unknown as MilkdownWindow).__futoTest.readDocument(),
    );
  }

  protected async snapshot(refused = false): Promise<EditorSnapshot> {
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
   * The `DriverState` shape (driverProtocol.ts), read off the rendered
   * ProseMirror DOM.
   * `doc` is the markdown the editor would save; `decorations` are the semantic
   * spans `checkSemanticIntent` looks for, keyed by the HTML the schema emits.
   */
  protected async readDriverState(): Promise<DriverState> {
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
        let pos: number;
        try {
          pos = view?.posAtDOM(element, side) ?? 0;
        } catch {
          pos = 0;
        }
        return { line: 0, ch: 0, pos };
      };
      /** An element's text with each `<br>` as the line break it renders. */
      const textOf = (node: Node): string =>
        node.nodeName === 'BR'
          ? '\n'
          : node.nodeType === Node.TEXT_NODE
            ? (node.textContent ?? '')
            : Array.from(node.childNodes).map(textOf).join('');
      const push = (element: Element, kind: DecoratedRange['kind']): void => {
        decorations.push({
          from: at(element, 0),
          to: at(element, 1),
          kind,
          replaced: false,
          classes: Array.from(element.classList),
          text: textOf(element),
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
        doc: testWindow.__futoTest.readDocument(),
        cursor: point(selection?.from ?? 0),
        selection: { anchor: point(selection?.from ?? 0), head: point(selection?.to ?? 0) },
        decorations,
        visibleText: (root as HTMLElement).innerText,
      };
    });
  }
}
