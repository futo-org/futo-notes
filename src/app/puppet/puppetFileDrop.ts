/* Files dragged in from the OS and dropped on the window at viewport `x`, `y`: the drag's
 * `dragover` then its `drop`, on the element under that point, each carrying the files as
 * WebKit and WebView2 deliver them (`dataTransfer.files`, the type `Files`). One file's bytes,
 * named once per name, so a drop can mix pictures with other files. */
import { puppetFile } from './puppetInput';
import { puppetRefusal as refuse, puppetVerb, type PuppetVerb } from './puppetRegistry';

function dragEvent(type: 'dragover' | 'drop', x: number, y: number, files: File[]): DragEvent {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    dataTransfer: transfer,
  });
}

/** `DropFiles {"x","y","names":"a.png,notes.md","base64"}`. */
export function dropFilesVerb(): PuppetVerb {
  return puppetVerb(
    'DropFiles',
    { x: 'integer', y: 'integer', names: 'string', base64: 'string' },
    (args) => {
      const x = args.x as number;
      const y = args.y as number;
      const target = document.elementFromPoint(x, y);
      if (!target) return refuse(409, `DropFiles: nothing is drawn at ${x}, ${y}`);
      const names = (args.names as string).split(',').filter((name) => name !== '');
      const files = names.map((name) => puppetFile(name, args.base64 as string));
      target.dispatchEvent(dragEvent('dragover', x, y, files));
      target.dispatchEvent(dragEvent('drop', x, y, files));
      return undefined;
    },
  );
}
