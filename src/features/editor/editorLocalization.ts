import { localizedText } from '$shared/localization';

export function localizedCodeMirrorPhrases(): Record<string, string> {
  return {
    Completions: localizedText('codeMirror.phrases.completions'),
    'Control character': localizedText('codeMirror.phrases.controlCharacter'),
    'Selection deleted': localizedText('codeMirror.phrases.selectionDeleted'),
    'Folded lines': localizedText('codeMirror.phrases.foldedLines'),
    'Unfolded lines': localizedText('codeMirror.phrases.unfoldedLines'),
    to: localizedText('codeMirror.phrases.rangeSeparator'),
    'folded code': localizedText('codeMirror.phrases.foldedCode'),
    unfold: localizedText('codeMirror.phrases.unfold'),
    'Fold line': localizedText('codeMirror.phrases.foldLine'),
    'Unfold line': localizedText('codeMirror.phrases.unfoldLine'),
  };
}
