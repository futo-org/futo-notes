import { readFile, writeFile } from 'node:fs/promises';

import { mergeForeignSweepShardReports, type ForeignSweepShardReport } from './foreignReport';

const args = process.argv.slice(2);
// pnpm run <script> -- <args> forwards its separator to the script.
if (args[0] === '--') args.shift();
const outputFlag = args.indexOf('--output');
const outputPath = outputFlag === -1 ? undefined : args[outputFlag + 1];
const inputPaths = args.filter(
  (_, index) => outputFlag === -1 || (index !== outputFlag && index !== outputFlag + 1),
);
if (inputPaths.length === 0 || (outputFlag !== -1 && !outputPath)) {
  throw new Error('usage: aggregateForeignReports.ts [--output report.json] <shard.json>...');
}

const reports = await Promise.all(
  inputPaths.map(async (inputPath) => {
    const json = await readFile(inputPath, 'utf8');
    return JSON.parse(json) as ForeignSweepShardReport;
  }),
);
const aggregate = mergeForeignSweepShardReports(reports);
const json = `${JSON.stringify(aggregate, null, 2)}\n`;
if (outputPath) await writeFile(outputPath, json);
process.stdout.write(`EDITOR_GAUNTLET_FOREIGN_AGGREGATE ${JSON.stringify(aggregate)}\n`);
