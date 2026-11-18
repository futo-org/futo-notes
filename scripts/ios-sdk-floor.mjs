#!/usr/bin/env node
// Fail an iOS build made with an SDK that Apple is about to stop accepting.
//
// Apple names each SDK for the year after its autumn release (iOS 27 shipped in
// 2026) and, from the following April, refuses App Store uploads built with an
// older one (ITMS-90725). The floor here moves on 1 January, three months ahead
// of Apple's, so the nightly build goes red while there is still time to move
// the Cirrus image in ci/cirrus/ios-*.yml to the new Xcode.
//
//   node scripts/ios-sdk-floor.mjs "$(xcodebuild -version -sdk iphoneos SDKVersion)"

// The SDK major a build made on `today` must have at least.
export function requiredSdkMajor(today) {
  return today.getUTCFullYear() - 2000;
}

// Null when `sdkVersion` (e.g. "27.2") meets the floor on `today`, otherwise
// the reason it does not. A version that cannot be read fails: a build whose
// SDK is unknown must not pass.
export function sdkFloorError(sdkVersion, today) {
  const major = Number.parseInt(String(sdkVersion).trim(), 10);
  if (!Number.isInteger(major)) {
    return `could not read an iOS SDK version from "${sdkVersion}"`;
  }
  const required = requiredSdkMajor(today);
  if (major >= required) return null;
  return (
    `this build uses the iOS ${String(sdkVersion).trim()} SDK, but from April ${today.getUTCFullYear()} ` +
    `Apple only accepts uploads built with the iOS ${required} SDK or later (ITMS-90725). ` +
    `Move the image in ci/cirrus/ios-*.yml to Xcode ${required}.`
  );
}

// Run only when invoked directly so the test can import the pure helpers.
if (import.meta.main) {
  const sdkVersion = process.argv[2] ?? '';
  const error = sdkFloorError(sdkVersion, new Date());
  if (error) {
    process.stderr.write(`ERROR: ${error}\n`);
    process.exit(1);
  }
  process.stdout.write(`iOS SDK ${sdkVersion.trim()} meets the App Store floor\n`);
}
