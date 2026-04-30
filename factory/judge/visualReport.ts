// Generate an HTML report for visual-similarity comparison results.
// Side-by-side SF / OB screenshots + the diff PNG, sorted by drift,
// emitted to factory/captures/visual-report.html.
//
// This is the artifact the LLM-judge phase consumes: when the user
// asks Claude Code to "review the visual report", Claude reads the
// individual PNG paths surfaced here and describes differences.

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { VisualDiffResult } from './visualDiff.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const REPORT_PATH = path.join(REPO, 'factory/captures/visual-report.html');

export function writeVisualReport(results: VisualDiffResult[]): string {
  mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  // Sort by drift descending so the worst cases are at the top.
  const sorted = [...results].sort((a, b) => b.diffRatio - a.diffRatio);
  const rel = (p: string) => path.relative(path.dirname(REPORT_PATH), p);

  const rows = sorted.map((r) => `
    <tr>
      <td>${escapeHtml(r.scenarioName)}</td>
      <td class="num">${r.diffPixels.toLocaleString()}</td>
      <td class="num">${(r.diffRatio * 100).toFixed(2)}%</td>
      <td class="num">${r.width}×${r.height}${r.sizesMatched ? '' : ' (cropped)'}</td>
      <td><img src="${rel(r.sfPath)}" alt="sf"></td>
      <td><img src="${rel(r.obPath)}" alt="ob"></td>
      <td><img src="${rel(r.diffPath)}" alt="diff"></td>
    </tr>
  `).join('\n');

  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Factory Visual Report</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; padding: 24px; max-width: 1400px; margin: 0 auto; color: #111; }
  h1 { margin: 0 0 8px; }
  .meta { color: #666; margin-bottom: 24px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { padding: 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  th { text-align: left; background: #f6f6f6; position: sticky; top: 0; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  img { max-width: 280px; max-height: 200px; border: 1px solid #ddd; display: block; image-rendering: pixelated; }
</style>
</head><body>
<h1>Factory visual diff</h1>
<div class="meta">
  ${results.length} scenarios compared. Sorted by drift desc.
  <br>To consult the LLM judge (Claude Code), say: "review the visual report" — Claude will read the PNG pairs and describe the structural differences.
</div>
<table>
  <thead>
    <tr><th>scenario</th><th>diff px</th><th>diff %</th><th>size</th><th>stonefruit</th><th>obsidian</th><th>diff</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`;

  writeFileSync(REPORT_PATH, html);
  return REPORT_PATH;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  } as Record<string, string>)[c]!);
}
