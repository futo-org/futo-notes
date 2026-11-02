import { expect, it } from 'vitest';
import { assertReconApks } from './android-performance-recon.mjs';

const app = "package: name='com.futo.notes.dev' versionCode='1'\napplication-debuggable\n";
const tests = "package: name='com.futo.notes.dev.test'\napplication-debuggable\n";
// Actual compiled-test APK aapt2 xmltree fields; badging does not list instrumentation.
const tree = `N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="com.futo.notes.dev.test" (Raw: "com.futo.notes.dev.test")
      E: instrumentation (line=9)
        A: http://schemas.android.com/apk/res/android:label(0x01010001)="Tests for com.futo.notes.dev" (Raw: "Tests for com.futo.notes.dev")
        A: http://schemas.android.com/apk/res/android:name(0x01010003)="androidx.test.runner.AndroidJUnitRunner" (Raw: "androidx.test.runner.AndroidJUnitRunner")
        A: http://schemas.android.com/apk/res/android:targetPackage(0x01010021)="com.futo.notes.dev" (Raw: "com.futo.notes.dev")
      E: application (line=24)
        A: http://schemas.android.com/apk/res/android:debuggable(0x0101000f)=true
`;

it('requires the dev debug app and its exact instrumentation target before install', () => {
  expect(() => assertReconApks(app, tests, tree)).not.toThrow();
  expect(() =>
    assertReconApks(app.replace('com.futo.notes.dev', 'com.futo.notes'), tests, tree),
  ).toThrow();
  expect(() => assertReconApks(app.replace('application-debuggable', ''), tests, tree)).toThrow();
  expect(() =>
    assertReconApks(
      app,
      tests,
      tree.replace(
        ':targetPackage(0x01010021)="com.futo.notes.dev"',
        ':targetPackage(0x01010021)="com.futo.notes"',
      ),
    ),
  ).toThrow();
});

it('does not borrow an instrumentation target from a different XML element', () => {
  const misplaced =
    tree.replace(':targetPackage(0x01010021)', ':otherAttribute(0x01010021)') +
    '        A: http://schemas.android.com/apk/res/android:targetPackage(0x01010021)="com.futo.notes.dev"\n';
  expect(() => assertReconApks(app, tests, misplaced)).toThrow();
  expect(() => assertReconApks(app, tests, `${tree}${tree}`)).toThrow();
});
