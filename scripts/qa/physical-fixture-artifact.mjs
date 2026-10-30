// Version-1 raw wire schema emitted by NativeInputRecorder.swift and the isolated
// CaptureWorkspace/FixtureController writer. This validates transport shapes,
// never callback ordering, editor semantics, range bounds or opaque identities.
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, required, optional = []) =>
  object(value) &&
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const text = (value) => typeof value === 'string';
const arrayOf = (value, predicate) => Array.isArray(value) && value.every(predicate);
const utf16 = (value) =>
  arrayOf(value, (unit) => Number.isInteger(unit) && unit >= 0 && unit <= 65535);
const pair = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isInteger);
const nullablePair = (value) => value === null || pair(value);
const token = (value) => value === null || Number.isInteger(value);

function snapshot(value) {
  return (
    shape(value, ['textUTF16', 'selected', 'marked', 'language', 'availableLanguages']) &&
    utf16(value.textUTF16) &&
    nullablePair(value.selected) &&
    nullablePair(value.marked) &&
    (value.language === null || text(value.language)) &&
    arrayOf(value.availableLanguages, text)
  );
}

function argumentsFor(method, value) {
  switch (method) {
    case 'shouldChangeText':
    case 'replace':
      return shape(value, ['range', 'textUTF16']) && pair(value.range) && utf16(value.textUTF16);
    case 'setMarkedText':
      return (
        shape(value, ['textUTF16', 'relativeSelection']) &&
        (value.textUTF16 === null || utf16(value.textUTF16)) &&
        pair(value.relativeSelection)
      );
    case 'insertText':
      return shape(value, ['textUTF16']) && utf16(value.textUTF16);
    case 'selectedTextRange':
      return shape(value, ['range']) && nullablePair(value.range);
    case 'insertDictationResult':
      return (
        shape(value, ['phrases']) &&
        arrayOf(
          value.phrases,
          (phrase) =>
            shape(phrase, ['textUTF16', 'alternativesUTF16']) &&
            utf16(phrase.textUTF16) &&
            (phrase.alternativesUTF16 === null || arrayOf(phrase.alternativesUTF16, utf16)),
        )
      );
    case 'frameForDictationResultPlaceholder':
      return shape(value, ['token']) && token(value.token);
    case 'removeDictationResultPlaceholder':
      return (
        shape(value, ['token', 'willInsertResult']) &&
        token(value.token) &&
        typeof value.willInsertResult === 'boolean'
      );
    case 'didChange':
    case 'didChangeSelection':
    case 'unmarkText':
    case 'deleteBackward':
    case 'insertDictationResultPlaceholder':
    case 'dictationRecordingDidEnd':
    case 'dictationRecognitionFailed':
      return shape(value, []);
    default:
      return false;
  }
}

function event(value) {
  if (!object(value)) return false;
  const required = ['id', 'parent', 'method', 'arguments', 'before', 'after'];
  if (value.method === 'shouldChangeText') required.push('returned');
  if (value.method === 'insertDictationResultPlaceholder') required.push('returnedToken');
  if (value.method === 'frameForDictationResultPlaceholder') required.push('returnedRect');
  return (
    shape(value, required, ['returned']) &&
    Number.isInteger(value.id) &&
    token(value.parent) &&
    text(value.method) &&
    argumentsFor(value.method, value.arguments) &&
    snapshot(value.before) &&
    snapshot(value.after) &&
    (!Object.hasOwn(value, 'returned') || typeof value.returned === 'boolean') &&
    (!Object.hasOwn(value, 'returnedToken') || Number.isInteger(value.returnedToken)) &&
    (!Object.hasOwn(value, 'returnedRect') ||
      (Array.isArray(value.returnedRect) &&
        value.returnedRect.length === 4 &&
        value.returnedRect.every((component) => Number.isFinite(component) || text(component))))
  );
}

function traits(value) {
  const enums = ['autocorrection', 'autocapitalization', 'spellChecking', 'keyboard'];
  const strings = ['deviceModel', 'systemName', 'systemVersion'];
  return (
    shape(value, [...enums, ...strings]) &&
    enums.every((key) => Number.isInteger(value[key])) &&
    strings.every((key) => text(value[key]))
  );
}

export function parseFixtureArtifact(raw) {
  let artifact;
  try {
    artifact = JSON.parse(raw);
  } catch {
    throw new Error('Malformed or partial capture artifact');
  }
  if (
    !shape(artifact, [
      'formatVersion',
      'runID',
      'nonce',
      'declaredDestination',
      'destinationBinding',
      'acceptance',
      'artifactRelativePath',
      'maximumDurationSeconds',
      'provenance',
      'status',
      'sourceUTF16',
      'opening',
      'current',
      'events',
      'lifecycle',
      'traits',
      'os',
    ]) ||
    artifact.formatVersion !== 1 ||
    !['runID', 'nonce', 'declaredDestination', 'destinationBinding', 'acceptance', 'status'].every(
      (key) => text(artifact[key]),
    ) ||
    !(artifact.artifactRelativePath === null || text(artifact.artifactRelativePath)) ||
    !Number.isInteger(artifact.maximumDurationSeconds) ||
    !object(artifact.provenance) ||
    !utf16(artifact.sourceUTF16) ||
    !snapshot(artifact.opening) ||
    !snapshot(artifact.current) ||
    !arrayOf(artifact.events, event) ||
    !arrayOf(
      artifact.lifecycle,
      (stamp) =>
        shape(stamp, ['event', 'uptime', 'time']) &&
        text(stamp.event) &&
        Number.isFinite(stamp.uptime) &&
        text(stamp.time),
    ) ||
    !traits(artifact.traits) ||
    !text(artifact.os) ||
    !artifact.os
  )
    throw new Error('Capture artifact is incomplete or has an incompatible recorder schema');
  return artifact;
}
