import { test, expect, Page } from '@playwright/test';

async function openNewNote(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForLoadState('domcontentloaded');
  await page.goto('/#/note/new');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.cm-editor', { timeout: 10000 });
  await page.waitForSelector('.cm-content', { timeout: 10000 });
}

async function seedRenamedNote(page: Page, id: string, content: string): Promise<void> {
  await page.evaluate(async ({ noteId, body }) => {
    const w = window as typeof window & {
      __testNotes: {
        createNote: (id: string, content: string) => Promise<void>;
      };
    };
    await w.__testNotes.createNote(noteId, body);
  }, { noteId: id, body: content });
}

async function seedNote(page: Page, id: string, content: string): Promise<void> {
  await page.evaluate(({ noteId, body }) => {
    const w = window as typeof window & {
      __notesShellTest: {
        seedOpenNote: (id: string, body: string) => void;
      };
    };
    w.__notesShellTest.seedOpenNote(noteId, body);
  }, { noteId: id, body: content });
}

test.describe('Remote Rename UX', () => {
  test('open note stays open when sync reports a rename', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'Old Title', 'Body content');
    await expect(page).toHaveURL(/#\/note\/Old%20Title$/);
    await expect(page.locator('.title-input')).toHaveValue('Old Title');
    await expect(page.locator('.cm-content')).toContainText('Body content');

    await seedRenamedNote(page, 'Renamed Title', 'Body content');

    await page.evaluate(async () => {
      const w = window as typeof window & {
        __notesShellTest: {
          handleSyncComplete: (summary: {
            uploaded: number;
            downloaded: number;
            deleted: number;
            conflicts: number;
            updatedIds: string[];
            deletedIds: string[];
            renamed: Array<{ fromId: string; toId: string }>;
            peerUpdatedIds: string[];
            peerDeletedIds: string[];
          }) => Promise<void>;
          handleFileChange: (event: { type: 'add' | 'change' | 'unlink'; filename: string }) => Promise<void>;
        };
      };
      await w.__notesShellTest.handleSyncComplete({
          uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        updatedIds: [],
        deletedIds: [],
        renamed: [{ fromId: 'Old Title', toId: 'Renamed Title' }],
        peerUpdatedIds: [],
        peerDeletedIds: [],
      });
      await w.__notesShellTest.handleFileChange({ type: 'unlink', filename: 'Old Title.md' });
    });

    await expect(page).toHaveURL(/#\/note\/Renamed%20Title$/);
    await expect(page.locator('.title-input')).toHaveValue('Renamed Title');
    await expect(page.locator('.cm-content')).toContainText('Body content');
    await expect(page.locator('.toast')).toHaveCount(0);
  });

  test('open note stays open when sync only reports delete plus collision-suffixed update', async ({ page }) => {
    await openNewNote(page);
    await seedNote(page, 'Old Title', 'Body content');
    await expect(page).toHaveURL(/#\/note\/Old%20Title$/);
    await expect(page.locator('.title-input')).toHaveValue('Old Title');
    await expect(page.locator('.cm-content')).toContainText('Body content');

    await seedRenamedNote(page, 'Old Title (2)', 'Body content');

    await page.evaluate(async () => {
      const w = window as typeof window & {
        __notesShellTest: {
          handleSyncComplete: (summary: {
            uploaded: number;
            downloaded: number;
            deleted: number;
            conflicts: number;
            updatedIds: string[];
            deletedIds: string[];
            renamed: Array<{ fromId: string; toId: string }>;
            peerUpdatedIds: string[];
            peerDeletedIds: string[];
          }) => Promise<void>;
        };
      };
      await w.__notesShellTest.handleSyncComplete({
        uploaded: 0,
        downloaded: 0,
        deleted: 1,
        conflicts: 0,
        updatedIds: ['Old Title (2)'],
        deletedIds: ['Old Title'],
        renamed: [],
        peerUpdatedIds: ['Old Title (2)'],
        peerDeletedIds: ['Old Title'],
      });
    });

    await expect(page).toHaveURL(/#\/note\/Old%20Title%20\(2\)$/);
    await expect(page.locator('.title-input')).toHaveValue('Old Title (2)');
    await expect(page.locator('.cm-content')).toContainText('Body content');
    await expect(page.locator('.toast')).toHaveCount(0);
    await expect(page.locator('text=For You')).toHaveCount(0);
  });
});
