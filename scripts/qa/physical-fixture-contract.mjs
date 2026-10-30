// Exact operator-template, keeper-manifest and terminal-receipt contracts for
// the one physical fixture. Unknown fields are errors before ownership changes.
const UUID = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const fields = [
  'formatVersion',
  'host',
  'deviceUDID',
  'coreDeviceID',
  'worktree',
  'sourceSHA',
  'sourceFingerprint',
  'runID',
  'nonce',
  'bundleID',
  'runnerBundleID',
  'seconds',
  'buildFingerprint',
];
const exact = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export function validateFixturePlan(plan, { template = false } = {}) {
  if (template && Object.hasOwn(plan ?? {}, 'ownerPID'))
    throw new Error('The reservation keeper owns its PID; omit ownerPID');
  if (
    !exact(plan, template ? fields : [...fields, 'ownerPID']) ||
    plan.formatVersion !== 1 ||
    typeof plan.host !== 'string' ||
    !plan.host ||
    typeof plan.worktree !== 'string' ||
    !/^[0-9A-F]{8}-[0-9A-F]{16}$/.test(plan.deviceUDID) ||
    !UUID.test(plan.coreDeviceID) ||
    !UUID.test(plan.runID) ||
    !UUID.test(plan.nonce) ||
    plan.runID === plan.nonce ||
    !/^[0-9a-f]{40}$/.test(plan.sourceSHA) ||
    !/^[0-9a-f]{64}$/.test(plan.sourceFingerprint) ||
    !/^[0-9a-f]{64}$/.test(plan.buildFingerprint) ||
    !Number.isInteger(plan.seconds) ||
    plan.seconds < 1 ||
    plan.seconds > 120 ||
    plan.bundleID !== 'org.futo.fixture.editor294' ||
    plan.runnerBundleID !== 'org.futo.fixture.editor294.uitests.xctrunner' ||
    (!template && (!Number.isSafeInteger(plan.ownerPID) || plan.ownerPID < 2))
  )
    throw new Error('Expected the fixed, bounded physical fixture manifest or template');
}

export function validateTerminalReceipt(plan, receipt, output) {
  const required = [
    'formatVersion',
    'runID',
    'nonce',
    'acceptance',
    'status',
    'installations',
    'output',
    'deviceObservations',
  ];
  const optional = ['result', 'error', 'artifactSHA256', 'rawReads'];
  const keys = Object.keys(receipt ?? {});
  if (
    !required.every((key) => keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    receipt.formatVersion !== 1 ||
    receipt.runID !== plan.runID ||
    receipt.nonce !== plan.nonce ||
    receipt.acceptance !== 'unreviewed-raw-capture' ||
    receipt.output !== output ||
    !['captured', 'failed'].includes(receipt.status) ||
    !Array.isArray(receipt.installations) ||
    receipt.installations.length > 2 ||
    receipt.installations.some(
      (item, i) =>
        !exact(item, ['bundleID', 'version', 'url']) ||
        item.bundleID !== [plan.bundleID, plan.runnerBundleID][i] ||
        typeof item.version !== 'string' ||
        !item.version ||
        typeof item.url !== 'string' ||
        !item.url,
    ) ||
    !Array.isArray(receipt.deviceObservations) ||
    !receipt.deviceObservations.length ||
    receipt.deviceObservations.some(
      (item) =>
        !item ||
        typeof item.at !== 'string' ||
        item.deviceUDID !== plan.deviceUDID ||
        item.coreDeviceID !== plan.coreDeviceID ||
        item.physical !== true ||
        item.available !== true ||
        item.unlocked !== true,
    ) ||
    (receipt.status === 'captured' &&
      (receipt.installations.length !== 2 ||
        !receipt.result ||
        !/^[0-9a-f]{64}$/.test(receipt.artifactSHA256) ||
        receipt.error !== undefined)) ||
    (receipt.status === 'failed' && (typeof receipt.error !== 'string' || !receipt.error)) ||
    (receipt.rawReads !== undefined &&
      (!Array.isArray(receipt.rawReads) ||
        receipt.rawReads.some(
          (read) =>
            !exact(read, ['path', 'sha256']) ||
            !/^[0-9a-f]{64}$/.test(read.sha256) ||
            typeof read.path !== 'string' ||
            !read.path.startsWith(output + '/failed-read-') ||
            !/^[0-9a-f-]{36}\/capture\.json$/.test(
              read.path.slice((output + '/failed-read-').length),
            ),
        )))
  )
    throw new Error('Cannot trust an incomplete, unknown or unfinished capture receipt');
}

export function validateFixtureResult(plan, result) {
  const gesture = result?.gesture;
  if (
    result?.totalTestCount !== 1 ||
    result.passedTests !== 1 ||
    result.failedTests !== 0 ||
    result.skippedTests !== 0 ||
    result.deviceUDID !== plan.deviceUDID ||
    result.testIdentifier !== 'DictationCaptureTests/testCapture'
  )
    throw new Error('Fixed XCTest scenario or actual device destination did not pass exactly once');
  const control = gesture?.control;
  if (
    gesture?.runID !== plan.runID ||
    gesture.nonce !== plan.nonce ||
    gesture.bundleID !== plan.bundleID ||
    gesture.destination !== plan.deviceUDID ||
    gesture.action !== 'tap-system-dictate' ||
    gesture.status !== 'capture-window-ended' ||
    control?.hittable !== true ||
    !['Dictate', 'Start Dictation'].includes(control.label) ||
    !control.frame ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(control.frame[key])) ||
    control.frame.width <= 0 ||
    control.frame.height <= 0
  )
    throw new Error('Missing or mismatched live system Dictate gesture receipt');
}
