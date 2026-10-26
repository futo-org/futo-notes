// Artifact destinations for the three Playwright runners. Playwright clears its
// output and HTML directories, so each runner/run must own sibling leaves.
// Keep unnamed JSON reports at the paths consumed by CI and editor-bench-gate.
export function playwrightArtifacts(runner, resultsFilename) {
  const runId = (process.env.PW_RUN_ID ?? '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
  const evidenceDir = process.env.FUTO_VERIFICATION_DIR;
  if (evidenceDir) {
    // Preserve verify-run's existing desktop layout. Native-editor runners
    // share the evidence root, but neither sits inside a directory desktop clears.
    const reportRoot = `${evidenceDir}/playwright${runner === 'desktop' ? '' : `/${runner}`}`;
    return {
      outputDir: `${reportRoot}/test-output`,
      jsonReport: `${reportRoot}/results.json`,
      htmlReport: `${reportRoot}/report`,
    };
  }
  // Prefixing named runs also keeps '.' and '..' from becoming path traversal.
  const leaf = runId ? `run-${runId}` : 'default';
  const outputDir = `test-results/${runner}/${leaf}`;
  return {
    outputDir,
    jsonReport: runId ? `${outputDir}/results.json` : `test-results/${resultsFilename}`,
    htmlReport: `playwright-report/${runner}/${leaf}`,
  };
}
