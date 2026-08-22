// Turn a spawnSync result into a message that names what actually went wrong.
//
// When spawnSync cannot find the binary at all, `status` is null and BOTH
// `stdout` and `stderr` are undefined — so the natural
// `${result.stderr || result.stdout}` renders the string "undefined" and the
// caller's error names neither the missing command nor ENOENT. That is how
// "Failed to hash test server password:\nundefined" was all a run said about a
// missing `bun` on PATH (pc_925496b61ef9). `result.error` is the only field
// carrying the answer, and nothing was reading it.
export function formatSpawnFailure(result, command) {
  if (result.error) {
    const code = result.error.code ?? 'unknown error';
    if (code === 'ENOENT') {
      return `'${command}' is not on PATH (ENOENT). Install it, or add it to PATH, then re-run.`;
    }
    return `could not run '${command}': ${code} — ${result.error.message}`;
  }
  if (result.signal) {
    return `'${command}' was killed by ${result.signal}.`;
  }
  const output = [result.stderr, result.stdout]
    .filter((s) => s && s.trim())
    .map((s) => s.trim())
    .join('\n');
  return output || `'${command}' exited with status ${result.status} and produced no output.`;
}
