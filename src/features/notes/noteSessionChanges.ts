export function shouldWriteNoteToDisk(params: {
  savedTitle: string;
  newTitle: string;
  content: string;
  newContent: string;
}): boolean {
  return !(params.newTitle === params.savedTitle && params.newContent === params.content);
}

export function editorHasUnseenChanges(params: {
  editorContent: string | undefined;
  savedContent: string;
  title: string;
  savedTitle: string;
}): boolean {
  if (params.editorContent === undefined) return false;
  return params.editorContent !== params.savedContent || params.title !== params.savedTitle;
}

export function isEditorChangeEcho(params: {
  nextContent: string | undefined;
  content: string;
  savedContent: string;
}): boolean {
  if (params.nextContent === undefined) return false;
  return params.nextContent === params.content && params.nextContent === params.savedContent;
}
