import type { Page } from '@playwright/test';

import type { Driver, DriverState } from '../../factory/driver/protocol';
import type {
  EditorGauntletAdapter,
  EditorIntentAction,
  EditorSnapshot,
  KeystrokeMeasurement,
  OpenMeasurement,
  SourceSelection,
} from './types';

interface NotesShellTestState {
  editorContent: string;
  toastMessage: string;
}

interface NotesShellTestHook {
  seedOpenNote(id: string, body: string): void;
  flushSave(): Promise<void>;
  getState(): NotesShellTestState;
}

interface TestNotesHook {
  writeNote(id: string, content: string): Promise<number>;
  readNote(id: string): Promise<string>;
}

type GauntletWindow = typeof window & {
  __cmGetView?: () => {
    state: {
      doc: { length: number; toString(): string };
      selection: { main: { from: number; to: number } };
    };
    dispatch(spec: unknown): void;
    focus(): void;
  } | null;
  __driver?: Driver;
  __notesShellTest?: NotesShellTestHook;
  __testNotes?: TestNotesHook;
};

async function waitForTwoFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

export class Cm6GauntletAdapter implements EditorGauntletAdapter {
  readonly name = 'current-cm6';
  private isReady = false;
  private pageErrors: string[] = [];
  /** One scratch note prevents a corpus sweep from benchmarking sidebar/cache cardinality. */
  private readonly noteId = 'editor-gauntlet-active';
  private openedSource = '';

  constructor(private readonly page: Page) {
    page.on('pageerror', (error) => this.pageErrors.push(error.message));
  }

  async open(source: string, _caseId: string): Promise<void> {
    if (!this.isReady) {
      await this.page.goto('/');
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.goto('/#/note/new');
      await this.page.waitForSelector('.cm-content', { timeout: 10_000 });
      await this.page.waitForFunction(() => {
        const testWindow = window as GauntletWindow;
        return Boolean(
          testWindow.__driver &&
          testWindow.__notesShellTest &&
          testWindow.__testNotes &&
          testWindow.__cmGetView?.(),
        );
      });
      this.isReady = true;
    }

    this.pageErrors = [];
    this.openedSource = source;
    await this.page.evaluate(
      async ({ id, body }) => {
        const testWindow = window as GauntletWindow;
        if (!testWindow.__notesShellTest || !testWindow.__testNotes) {
          throw new Error('notes test hooks are unavailable');
        }
        await testWindow.__testNotes.writeNote(id, body);
        testWindow.__notesShellTest.seedOpenNote(id, body);
      },
      { id: this.noteId, body: source },
    );
    await this.page.waitForFunction(
      (expected) => (window as GauntletWindow).__cmGetView?.()?.state.doc.toString() === expected,
      source.replace(/\r\n?/g, '\n'),
    );
    await waitForTwoFrames(this.page);
  }

  async select(selection: SourceSelection): Promise<void> {
    const anchor = this.normalizedPosition(selection.anchor);
    const head = this.normalizedPosition(selection.head ?? selection.anchor);
    await this.page.evaluate(
      ({ anchor, head }) => {
        const view = (window as GauntletWindow).__cmGetView?.();
        if (!view) throw new Error('CM6 view is unavailable');
        view.dispatch({ selection: { anchor, head: head ?? anchor } });
        view.focus();
      },
      { anchor, head },
    );
  }

  async perform(action: EditorIntentAction): Promise<EditorSnapshot[]> {
    switch (action.type) {
      case 'enter':
        await this.page.keyboard.press('Enter');
        break;
      case 'backspace':
        await this.page.keyboard.press('Backspace');
        break;
      case 'insert-text':
        await this.page.keyboard.insertText(action.text);
        break;
      case 'paste':
        await this.page.locator('.cm-content').evaluate((content, text) => {
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
    await waitForTwoFrames(this.page);
    observations.push(await this.snapshot());
    return observations;
  }

  async save(): Promise<EditorSnapshot> {
    let refused = false;
    try {
      await this.page.evaluate(async () => {
        const hook = (window as GauntletWindow).__notesShellTest;
        if (!hook) throw new Error('notes shell test hook is unavailable');
        await hook.flushSave();
      });
    } catch {
      refused = true;
    }
    return this.snapshot(refused);
  }

  async undo(): Promise<EditorSnapshot> {
    await this.page.keyboard.press('ControlOrMeta+z');
    await waitForTwoFrames(this.page);
    return this.save();
  }

  async walkCaret(positions: number[]): Promise<void> {
    for (const position of positions) {
      await this.select({ anchor: position });
      await this.page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
    }
  }

  async measureOpen(source: string): Promise<OpenMeasurement> {
    const measurement = await this.page.evaluate(async (markdown) => {
      const view = (window as GauntletWindow).__cmGetView?.();
      if (!view) throw new Error('CM6 view is unavailable');
      const startedAt = performance.now();
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: markdown },
        selection: { anchor: 0 },
      });
      const synchronousMs = performance.now() - startedAt;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return { synchronousMs, settledMs: performance.now() - startedAt };
    }, source);
    return {
      bytes: new TextEncoder().encode(source).length,
      lines: source.split('\n').length,
      ...measurement,
    };
  }

  async measureKeystrokes(count: number): Promise<KeystrokeMeasurement> {
    return this.page.evaluate(async (sampleCount) => {
      const view = (window as GauntletWindow).__cmGetView?.();
      if (!view) throw new Error('CM6 view is unavailable');
      const synchronousSamplesMs: number[] = [];
      const settledToPaintSamplesMs: number[] = [];
      for (let index = 0; index < sampleCount; index += 1) {
        const position = view.state.selection.main.from;
        const startedAt = performance.now();
        view.dispatch({
          changes: { from: position, to: view.state.selection.main.to, insert: 'x' },
          selection: { anchor: position + 1 },
          userEvent: 'input.type',
        });
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

  private async snapshot(refused = false): Promise<EditorSnapshot> {
    const [driverState, shellState, persistedSource] = await Promise.all([
      this.readDriverState(),
      this.page.evaluate(() => {
        const hook = (window as GauntletWindow).__notesShellTest;
        if (!hook) throw new Error('notes shell test hook is unavailable');
        return hook.getState();
      }),
      this.page.evaluate(async (id) => {
        const notes = (window as GauntletWindow).__testNotes;
        if (!notes) throw new Error('notes storage test hook is unavailable');
        return notes.readNote(id);
      }, this.noteId),
    ]);
    const warnings = [...this.pageErrors];
    if (shellState.toastMessage) warnings.push(shellState.toastMessage);
    return {
      source: driverState.doc,
      shellSource: shellState.editorContent,
      savedSource: persistedSource,
      visibleText: driverState.visibleText,
      decorations: driverState.decorations,
      warnings,
      refused,
      mode: 'rich',
    };
  }

  private async readDriverState(): Promise<DriverState> {
    return this.page.evaluate(async () => {
      const driver = (window as GauntletWindow).__driver;
      if (!driver) throw new Error('factory editor driver is unavailable');
      return driver.state();
    });
  }

  private normalizedPosition(rawPosition: number): number {
    return this.openedSource.slice(0, rawPosition).replace(/\r\n?/g, '\n').length;
  }
}
