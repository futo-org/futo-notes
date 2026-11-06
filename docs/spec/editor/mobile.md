# Native mobile text-first editor

Behaviors of the native text-first editor that iOS and Android share: the engine
(portable-core) rendered by native views, as opposed to the desktop WYSIWYG
editor. Lines here are *(mobile)*: true on iOS and Android alike.

- A line moves here from an *(Android text-first editor)* tag in the same commit
  that makes it pass on iOS. Until then it keeps its *(Android)* tag.
- A line that is truly platform-specific (a keyboard, gesture or OS service one
  platform has and the other lacks) keeps its *(iOS)* or *(Android)* tag.
- Engine behavior independent of any renderer belongs in
  [portable-core](portable-core.md), not here.

The section files under `mobile/` are added as lines move; none yet.
