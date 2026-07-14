function isExternalFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.prototype.includes.call(types, 'Files');
}

export function handleWindowDragOver(e: DragEvent): void {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
}

export function handleWindowDrop(e: DragEvent): void {
  if (!isExternalFileDrag(e)) return;
  e.preventDefault();
}

export function installExternalFileDropGuard(): void {
  window.addEventListener('dragover', handleWindowDragOver);
  window.addEventListener('drop', handleWindowDrop);
}
