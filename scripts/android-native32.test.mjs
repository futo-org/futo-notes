import { expect, it } from 'vitest';
import {
  parseInstrumentationResult,
  selectedClasses,
  validateManagedTarget,
} from './android-native32.mjs';

const cls = 'com.futo.notes.editor.NativeEditorSessionTest';
const result = (name, code = 0) => `INSTRUMENTATION_STATUS: class=${cls}
INSTRUMENTATION_STATUS: test=${name}
INSTRUMENTATION_STATUS: numtests=2
INSTRUMENTATION_STATUS_CODE: 1
INSTRUMENTATION_STATUS: class=${cls}
INSTRUMENTATION_STATUS: test=${name}
INSTRUMENTATION_STATUS: numtests=2
INSTRUMENTATION_STATUS_CODE: ${code}
`;
const complete = `${result('first')}${result('second')}INSTRUMENTATION_RESULT: stream=
Time: 0.5

OK (2 tests)

INSTRUMENTATION_CODE: -1
`;

it('accepts exactly the requested methods when the instrumentation finishes successfully', () => {
  expect(parseInstrumentationResult(complete, cls, ['first', 'second'])).toEqual([
    'first',
    'second',
  ]);
  expect(
    parseInstrumentationResult(complete.replaceAll('\n', '\r\n'), cls, ['first', 'second']),
  ).toEqual(['first', 'second']);
});

it.each([
  ['missing method', complete.replace(result('second'), '')],
  ['duplicate method', complete.replace(result('second'), result('first'))],
  ['failed method', complete.replace(result('second'), result('second', -2))],
  ['ignored method', complete.replace(result('second'), result('second', -3))],
  ['foreign class', complete.replaceAll(cls, `${cls}Other`)],
  ['incomplete run', complete.replace('INSTRUMENTATION_CODE: -1', '')],
  ['runner failure', complete.replace('INSTRUMENTATION_CODE: -1', 'INSTRUMENTATION_CODE: 0')],
  ['wrong total', complete.replaceAll('numtests=2', 'numtests=1')],
  ['no success summary', complete.replace('OK (2 tests)', 'FAILURES!!!')],
  [
    'finish before start',
    complete.replace('INSTRUMENTATION_STATUS_CODE: 1', 'INSTRUMENTATION_STATUS_CODE: 0'),
  ],
])('rejects a %s even when adb itself exits successfully', (_, output) => {
  expect(() => parseInstrumentationResult(output, cls, ['first', 'second'])).toThrow();
});

it('selects the existing consumers and refuses duplicate or foreign classes', () => {
  const link = 'com.futo.notes.editor.NativeEditorLinkTest';
  expect(selectedClasses([])).toEqual([
    cls,
    'com.futo.notes.editor.NativeEditorBlockRegressionTest',
    'com.futo.notes.editor.NativeEditorCompositionTest',
    'com.futo.notes.editor.NativeEditorStructuralSeamTest',
    link,
  ]);
  expect(selectedClasses([link])).toEqual([link]);
  expect(selectedClasses([cls])).toEqual([cls]);
  expect(() => selectedClasses([cls, cls])).toThrow();
  expect(() => selectedClasses(['com.other.Test'])).toThrow();
});

it('requires an explicitly selected managed QA emulator before any adb operation', () => {
  expect(() => validateManagedTarget('emulator-5554', 'futo-api29')).not.toThrow();
  expect(() => validateManagedTarget('emulator-5554', 'futo-qa-0')).not.toThrow();
  for (const name of [undefined, 'personal-unclaimed-avd', 'futo-qa-999'])
    expect(() => validateManagedTarget('emulator-5554', name)).toThrow();
  expect(() => validateManagedTarget('ZY22HSGXSG', 'futo-api29')).toThrow();
});
