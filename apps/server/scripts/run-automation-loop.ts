import { runAutomationLoop } from '../src/automationLoop.js';

interface ParsedArgs {
  sourcePath?: string;
  outputRoot?: string;
  modelsPath?: string;
  plugins: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    plugins: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      parsed.sourcePath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--output-root') {
      parsed.outputRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--models-path') {
      parsed.modelsPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--plugin') {
      const pluginId = argv[index + 1];
      if (!pluginId) {
        throw new Error('--plugin requires a value');
      }
      parsed.plugins.push(pluginId);
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printHelp(): void {
  console.log(`Usage:
  npm run automation:loop -- [--source <path>] [--output-root <path>] [--models-path <path>] [--plugin <id> ...]

Defaults:
  --source      ~/Documents/demo-vault-backup
  --output-root <repo>/.tmp/automation-loop
  --models-path <repo>/data/models
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runAutomationLoop({
    sourcePath: args.sourcePath,
    outputRoot: args.outputRoot,
    modelsPath: args.modelsPath,
    plugins: args.plugins,
  });

  console.log(`Run directory: ${result.runDir}`);
  console.log(`Working vault: ${result.workingVaultPath}`);
  console.log(`Diff: ${result.diffPath}`);
  console.log(`Summary: ${result.summaryPath}`);
  console.log(`Report: ${result.reportPath}`);
  console.log('');
  console.log('Plugin results:');
  for (const plugin of result.pluginResults) {
    console.log(`- ${plugin.status.toUpperCase()} ${plugin.pluginId}${plugin.errorMessage ? ` - ${plugin.errorMessage}` : ''}`);
  }
  console.log('');
  console.log(`Changed files: ${result.changedFiles.length}`);
  for (const file of result.changedFiles) {
    console.log(`- ${file}`);
  }

  if (result.pluginResults.some((plugin) => plugin.status !== 'succeeded')) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
