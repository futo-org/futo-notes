// xcodegen postGenCommand: give the FutoNotesNative scheme's Test action the
// same StoreKit configuration its Run action has. xcodegen writes only the
// Run action's, and without it in the Test action xcodebuild starts no local
// StoreKit server, so every SKTestSession test talks to the real Sandbox.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scheme = path.join(
  here,
  '../apps/ios/FutoNotesNative.xcodeproj/xcshareddata/xcschemes/FutoNotesNative.xcscheme',
);

const xml = readFileSync(scheme, 'utf8');
const reference = xml.match(
  /[ \t]*<StoreKitConfigurationFileReference[\s\S]*?<\/StoreKitConfigurationFileReference>\n/,
);
if (!reference) throw new Error(`no StoreKit configuration in ${scheme}'s Run action`);
const test = xml.match(/<TestAction[\s\S]*?<\/TestAction>/);
if (!test) throw new Error(`no TestAction in ${scheme}`);
if (!test[0].includes('StoreKitConfigurationFileReference')) {
  writeFileSync(scheme, xml.replace('   </TestAction>', `${reference[0]}   </TestAction>`));
}
