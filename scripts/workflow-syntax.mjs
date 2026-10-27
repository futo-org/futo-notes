#!/usr/bin/env node
// Validate the workflow runner's async-function grammar, without running agents.
// Its one module export is `export const meta`; await/return belong to the body.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function validate(source, file) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const diagnostic = parsed.parseDiagnostics[0];
  if (diagnostic) {
    const position = parsed.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    throw new Error(
      `${file}:${position.line + 1}:${position.character + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}\n${source.split(/\r?\n/)[position.line]}`,
    );
  }
  const removals = [];
  for (const statement of parsed.statements) {
    const exported = statement.modifiers?.find(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported || ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      if (
        !exported ||
        !ts.isVariableStatement(statement) ||
        !(statement.declarationList.flags & ts.NodeFlags.Const) ||
        statement.declarationList.declarations.length !== 1 ||
        !ts.isIdentifier(statement.declarationList.declarations[0].name) ||
        statement.declarationList.declarations[0].name.text !== 'meta'
      ) {
        throw new Error(`${file}: only export const meta is supported by the workflow runner`);
      }
      removals.push([exported.getStart(parsed), exported.end]);
    }
  }
  let body = source;
  for (const [start, end] of removals.reverse())
    body = body.slice(0, start) + ' '.repeat(end - start) + body.slice(end);
  try {
    new AsyncFunction(body);
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function defaults() {
  const directory = path.join(root, '.claude/workflows');
  const files = fs
    .readdirSync(directory)
    .filter((file) => file.endsWith('.js'))
    .map((file) => path.join(directory, file));
  const skills = path.join(root, '.claude/skills');
  for (const name of fs.readdirSync(skills)) {
    const file = path.join(skills, name, 'workflow.js');
    if (fs.existsSync(file)) files.push(file);
  }
  return files.sort();
}

function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: just check-workflows [file.js ...] (default: repository workflows)
Example: just check-workflows .claude/workflows/bugfix-pipeline.js
Checks async function bodies with top-level await/return and export const meta.
Plain node --check rejects valid workflow returns. This checker parses declarations,
removes only meta's export keyword, then compiles without executing source or metadata.
Other exports fail; errors name the file (parser errors include source lines).
No agents or devices run. Proves syntax, not runtime APIs or agent responses.`);
    return 0;
  }
  if (args.some((arg) => arg.startsWith('-'))) throw new Error('Unknown workflow-check option');
  const files = args.length ? args : defaults();
  if (!files.length) throw new Error('No workflow files found');
  for (const file of files) validate(fs.readFileSync(file, 'utf8'), file);
  console.log(`Workflow syntax OK — ${files.length} workflow(s); source was not executed.`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
