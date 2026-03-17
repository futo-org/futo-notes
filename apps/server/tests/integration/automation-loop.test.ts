import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __setTestLlmResponder } from '../../src/plugins/llm.js';
import { runAutomationLoop } from '../../src/automationLoop.js';

function weeklyNoteTitle(): string {
  // Build a weekly note title whose date range covers "now" so that
  // candidate notes (created at the current time) fall within the
  // modifiedBefore window used by the weekly-related-notes plugin.
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay()); // Sunday
  const end = new Date(start);
  end.setDate(end.getDate() + 6); // Saturday
  const fmt = (d: Date) => `${d.getMonth() + 1}-${d.getDate()}`;
  return `This week (${fmt(start)}-${start.getFullYear()} to ${fmt(end)})`;
}

function createVault(rootDir: string): { sourcePath: string; weeklyTitle: string } {
  const sourcePath = path.join(rootDir, 'source-vault');
  const weeklyTitle = weeklyNoteTitle();
  fs.mkdirSync(sourcePath, { recursive: true });
  fs.writeFileSync(path.join(sourcePath, 'Inbox.md'), '- Existing task\n', 'utf8');
  fs.writeFileSync(path.join(sourcePath, 'Untitled.md'), 'Buy milk and bread for the project trip home.\n', 'utf8');
  fs.writeFileSync(path.join(sourcePath, 'Tagged note.md'), '#project\n\nProject roadmap for the new demo environment and delivery plan.\n', 'utf8');
  fs.writeFileSync(path.join(sourcePath, 'Fresh note.md'), 'This note is about the project demo and release checklist for the next sprint.\n', 'utf8');
  fs.writeFileSync(path.join(sourcePath, `${weeklyTitle}.md`), 'We need to ship the project demo and prepare the automation review this week.\n', 'utf8');
  fs.writeFileSync(path.join(sourcePath, 'Project planning.md'), 'Project planning for the demo week includes release prep, task triage, and test automation.\n', 'utf8');
  return { sourcePath, weeklyTitle };
}

describe('automation loop', () => {
  let tempRoot: string | null = null;

  afterEach(() => {
    __setTestLlmResponder(null);
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('copies a vault, runs built-in automations, and writes diff artifacts', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-loop-'));
    const { sourcePath, weeklyTitle } = createVault(tempRoot);
    const outputRoot = path.join(tempRoot, 'runs');

    __setTestLlmResponder((input) => {
      if (input.purpose === 'auto-tagger-classify') {
        return '{"tags":["project"]}';
      }
      if (input.purpose === 'quick-capture-to-list-selection') {
        return 'Inbox';
      }
      if (input.purpose === 'weekly-related-notes-selection') {
        return '{"links":[]}';
      }
      throw new Error(`Unexpected test LLM purpose: ${input.purpose}`);
    });

    const result = await runAutomationLoop({
      sourcePath,
      outputRoot,
    });

    expect(result.pluginResults.map((plugin) => plugin.status)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
    ]);

    expect(fs.existsSync(result.diffPath)).toBe(true);
    expect(fs.existsSync(result.summaryPath)).toBe(true);
    expect(fs.existsSync(result.reportPath)).toBe(true);

    const inbox = fs.readFileSync(path.join(result.workingVaultPath, 'Inbox.md'), 'utf8');
    expect(inbox).toContain('Buy milk and bread');
    expect(fs.existsSync(path.join(result.workingVaultPath, 'Untitled.md'))).toBe(false);

    const fresh = fs.readFileSync(path.join(result.workingVaultPath, 'Fresh note.md'), 'utf8');
    expect(fresh).toContain('#project');

    const weekly = fs.readFileSync(path.join(result.workingVaultPath, `${weeklyTitle}.md`), 'utf8');
    expect(weekly).toContain('## Related Notes');
    expect(weekly).toContain('[[');

    const sourceUntitled = fs.readFileSync(path.join(sourcePath, 'Untitled.md'), 'utf8');
    expect(sourceUntitled).toContain('Buy milk and bread');

    const diff = fs.readFileSync(result.diffPath, 'utf8');
    expect(diff).toContain('Inbox.md');
    expect(diff).toContain('Fresh note.md');
  });

  it('respects the selected built-in plugin subset', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-loop-'));
    const { sourcePath, weeklyTitle } = createVault(tempRoot);
    const outputRoot = path.join(tempRoot, 'runs');

    const result = await runAutomationLoop({
      sourcePath,
      outputRoot,
      plugins: ['quick-capture-to-list'],
    });

    expect(result.pluginResults).toHaveLength(1);
    expect(result.pluginResults[0]).toMatchObject({
      pluginId: 'quick-capture-to-list',
      status: 'succeeded',
    });

    const inbox = fs.readFileSync(path.join(result.workingVaultPath, 'Inbox.md'), 'utf8');
    expect(inbox).toContain('Buy milk and bread');

    const fresh = fs.readFileSync(path.join(result.workingVaultPath, 'Fresh note.md'), 'utf8');
    expect(fresh).not.toContain('#project');

    const weekly = fs.readFileSync(path.join(result.workingVaultPath, `${weeklyTitle}.md`), 'utf8');
    expect(weekly).not.toContain('## Related Notes');
  });
});
