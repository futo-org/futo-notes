import { Directory, Paths } from "expo-file-system";

const NOTES_DIR = "notes";

/**
 * Get or create the notes directory in the app's private document directory.
 */
export function getNotesDirectory(): Directory {
  const notesDir = new Directory(Paths.document, NOTES_DIR);
  if (!notesDir.exists) {
    notesDir.create();
  }
  return notesDir;
}
