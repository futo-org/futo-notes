// A Playwright web-first assertion (`expect(locator).toHaveText(...)`) returns a
// promise that polls. Left un-awaited it does not fail the test: the test
// returns first, the assertion runs (or is dropped) after teardown, and the
// spec is green whatever the page did. `expect(await locator).toHaveText(...)`
// is the same bug in a subtler shape - the inner await resolves the locator,
// the assertion itself still floats (RC-34, AGENTS.md M11).
//
// The tests/ tree has no tsconfig, so `@typescript-eslint/no-floating-promises`
// cannot type-check it; this walks the syntax tree instead.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Matchers that Playwright implements as async (web-first / retrying). The sync
// generic ones (toBe, toEqual, toContain, ...) are deliberately not listed.
const ASYNC_MATCHERS = new Set([
  'toBeAttached',
  'toBeChecked',
  'toBeDisabled',
  'toBeEditable',
  'toBeEmpty',
  'toBeEnabled',
  'toBeFocused',
  'toBeHidden',
  'toBeInViewport',
  'toBeOK',
  'toBeVisible',
  'toContainClass',
  'toContainText',
  'toHaveAccessibleDescription',
  'toHaveAccessibleErrorMessage',
  'toHaveAccessibleName',
  'toHaveAttribute',
  'toHaveClass',
  'toHaveCount',
  'toHaveCSS',
  'toHaveId',
  'toHaveJSProperty',
  'toHaveRole',
  'toHaveScreenshot',
  'toHaveText',
  'toHaveTitle',
  'toHaveURL',
  'toHaveValue',
  'toHaveValues',
  'toMatchAriaSnapshot',
  'toPass',
]);

function collectTs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collectTs(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** `expect(x).not.toHaveText(...)` / `expect.poll(...).toBe(...)` -> matcher info. */
function expectMatcherCall(node) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return null;
  const matcher = node.expression.name.text;
  let target = node.expression.expression;
  while (
    ts.isPropertyAccessExpression(target) &&
    ['not', 'resolves', 'rejects'].includes(target.name.text)
  ) {
    target = target.expression;
  }
  if (!ts.isCallExpression(target)) return null;
  const callee = target.expression;
  if (ts.isIdentifier(callee) && callee.text === 'expect') return { matcher, poll: false };
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'expect' &&
    ['soft', 'poll'].includes(callee.name.text)
  ) {
    return { matcher, poll: callee.name.text === 'poll' };
  }
  return null;
}

/** True when the expression's promise is consumed by its parent. */
function isHandled(node) {
  const parent = node.parent;
  return (
    ts.isAwaitExpression(parent) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === node) ||
    ts.isArrayLiteralExpression(parent) || // Promise.all([...])
    ts.isPropertyAccessExpression(parent) || // .then / .catch chains
    (ts.isCallExpression(parent) && parent.arguments.includes(node))
  );
}

function findFloatingExpects(sourceText, fileName = 'spec.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    const info = expectMatcherCall(node);
    if (info && (info.poll || ASYNC_MATCHERS.has(info.matcher)) && !isHandled(node)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      found.push({ line: line + 1, matcher: info.matcher });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('un-awaited Playwright assertions', () => {
  it('flags the shapes that pass silently', () => {
    expect(
      findFloatingExpects(`
        expect(await page.locator('h1')).toHaveText('x');
        expect(page.locator('h1')).toBeVisible();
        expect.poll(() => n).toBe(1);
        await expect(page.locator('h1')).toHaveText('x');
        expect(saved).toContain('x');
        return expect(page.locator('h1')).toBeVisible();
      `).map((f) => f.matcher),
    ).toEqual(['toHaveText', 'toBeVisible', 'toBe']);
  });

  it('finds none under tests/', () => {
    const offenders = [];
    for (const file of collectTs(join(ROOT, 'tests'))) {
      for (const { line, matcher } of findFloatingExpects(readFileSync(file, 'utf8'), file)) {
        offenders.push(`${relative(ROOT, file)}:${line} ${matcher} is not awaited`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
