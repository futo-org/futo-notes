// What an authored save writes (portable-core/recovery.md): a nonempty source
// without a final line ending gains its own (CRLF or LF).
export const savedSource = (source) =>
  source === '' || source.endsWith('\n')
    ? source
    : source + (source.includes('\r\n') ? '\r\n' : '\n');
