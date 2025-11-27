import {
  MarkdownTextInput,
  parseExpensiMark,
} from "@expensify/react-native-live-markdown";
import { Directory, File, Paths } from "expo-file-system";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useNotesStore } from "../../lib/notesStore";

const NOTES_DIR = "notes";

/**
 * Sanitize a string to be used as a filename.
 * Removes or replaces characters that are invalid in filenames.
 */
function sanitizeFilename(text: string): string {
  // Get the first line of text
  const firstLine = text.split("\n")[0].trim();

  // Remove markdown heading markers
  const withoutHeading = firstLine.replace(/^#+\s*/, "");

  // Replace invalid filename characters with underscores
  // Invalid chars: / \ : * ? " < > |
  let sanitized = withoutHeading.replace(/[/\\:*?"<>|]/g, "_");

  // Replace multiple spaces/underscores with single underscore
  sanitized = sanitized.replace(/[\s_]+/g, "_");

  // Remove leading/trailing underscores and dots
  sanitized = sanitized.replace(/^[_.\s]+|[_.\s]+$/g, "");

  // Limit length to 100 characters
  sanitized = sanitized.slice(0, 100);

  // If empty after sanitization, use a default name
  if (!sanitized) {
    sanitized = "untitled";
  }

  return sanitized;
}

/**
 * Get or create the notes directory in the app's private document directory.
 */
function getNotesDirectory(): Directory {
  const notesDir = new Directory(Paths.document, NOTES_DIR);
  if (!notesDir.exists) {
    notesDir.create();
  }
  return notesDir;
}

export default function NoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const updateNote = useNotesStore((state) => state.updateNote);
  const [text, setText] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const currentFileRef = useRef<File | null>(null);
  const originalIdRef = useRef<string>("");
  const originalTextRef = useRef<string>("");

  useEffect(() => {
    loadNote();
  }, [id]);

  // Only save if content has actually changed from original
  useEffect(() => {
    if (isLoaded && text && text !== originalTextRef.current) {
      saveNote();
    }
  }, [text, isLoaded]);

  // Update the header title based on the note content
  useEffect(() => {
    if (text) {
      // Convert underscores to spaces for display
      const title = sanitizeFilename(text).replace(/_/g, " ") || "New Note";
      navigation.setOptions({ title });
    } else {
      navigation.setOptions({ title: "New Note" });
    }
  }, [text, navigation]);

  const loadNote = useCallback(async () => {
    try {
      if (id === "new") {
        // Creating a new note - original is empty
        originalIdRef.current = "";
        originalTextRef.current = "";
        setIsLoaded(true);
        return;
      }

      const notesDir = getNotesDirectory();
      const noteFile = new File(notesDir, `${id}.md`);

      if (noteFile.exists) {
        const content = await noteFile.text();
        currentFileRef.current = noteFile;
        originalIdRef.current = id;
        originalTextRef.current = content;
        setText(content);
      }
    } catch (error) {
      console.error("Error loading note:", error);
    } finally {
      setIsLoaded(true);
    }
  }, [id]);

  const saveNote = useCallback(async () => {
    try {
      const notesDir = getNotesDirectory();
      const newId = sanitizeFilename(text);
      const filename = newId + ".md";
      const newFile = new File(notesDir, filename);

      // If the filename changed and we have an existing file, delete the old one
      if (
        currentFileRef.current &&
        currentFileRef.current.uri !== newFile.uri
      ) {
        if (currentFileRef.current.exists) {
          currentFileRef.current.delete();
        }
      }

      // Write the content to the new file
      if (!newFile.exists) {
        newFile.create();
      }
      newFile.write(text);
      currentFileRef.current = newFile;

      // Optimistically update the store so the list shows changes immediately
      const oldId = originalIdRef.current || newId;
      updateNote(oldId, newId, text);

      // Update refs so we don't re-save unchanged content
      originalIdRef.current = newId;
      originalTextRef.current = text;
    } catch (error) {
      console.error("Error saving note:", error);
    }
  }, [text, updateNote]);

  return (
    <View style={styles.container}>
      <MarkdownTextInput
        value={text}
        onChangeText={setText}
        style={styles.input}
        multiline
        parser={parseExpensiMark}
        placeholder="Start typing your note..."
        autoFocus={id === "new"}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
  },
});
