import { MAX_TITLE_LENGTH, type FilenameIssueKind } from '$lib/rules';
import type { LocalizedMessage } from '$shared/localization';

export function titleValidationMessage(kind: FilenameIssueKind): LocalizedMessage {
  switch (kind) {
    case 'empty':
      return { path: 'notes.title.empty' };
    case 'forbidden_chars':
      return { path: 'notes.title.forbiddenCharacter' };
    case 'leading_dots':
      return { path: 'notes.title.leadingDot' };
    case 'trailing_dots':
      return { path: 'notes.title.trailingDot' };
    case 'too_long':
      return { path: 'notes.title.tooLong', arguments: { maxLength: MAX_TITLE_LENGTH } };
    case 'reserved_name':
      return { path: 'notes.title.forbiddenCharacter' };
    case 'case_collision':
      return { path: 'notes.title.duplicate' };
    case 'depth_exceeded':
      throw new Error('A note title cannot have a depth validation issue');
  }
}
