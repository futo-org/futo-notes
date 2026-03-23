import fs from 'node:fs';
import path from 'node:path';
import { runAutomationLoop } from '../src/automationLoop.js';

async function main() {
  const sourcePath = path.resolve(process.env.HOME || '', 'Documents/stonefruit');
  const tempSource = fs.mkdtempSync('/tmp/ralph-src-');
  fs.cpSync(sourcePath, tempSource, { recursive: true });
  const exclude = path.join(tempSource, '3-20-2026.md');
  if (fs.existsSync(exclude)) fs.unlinkSync(exclude);

  const result = await runAutomationLoop({ sourcePath: tempSource, plugins: ['daily-note'] });
  const dailyNoteResult = result.pluginResults.find(p => p.pluginId === 'daily-note');
  console.error(`[ralph] ${dailyNoteResult?.status ?? 'not found'}`);

  const today = new Date();
  const fn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}.md`;
  const dp = path.join(result.workingVaultPath, fn);
  if (fs.existsSync(dp)) console.log(fs.readFileSync(dp, 'utf8'));
  else if (dailyNoteResult?.detailPath && fs.existsSync(dailyNoteResult.detailPath)) {
    const d = JSON.parse(fs.readFileSync(dailyNoteResult.detailPath, 'utf8'));
    if (d.items?.[0]?.after?.content) console.log(d.items[0].after.content);
  }
  fs.rmSync(tempSource, { recursive: true, force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
