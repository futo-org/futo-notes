import {
  MarkdownTextInput,
  parseMarkdown,
} from "@expensify/react-native-live-markdown";
import { Directory, File, Paths } from "expo-file-system";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
} from "react-native";
import { useNotesStore } from "@/lib/notesStore";
import { renameNoteInIndex, updateNoteInIndex } from "@/lib/notesLoader";
import { colors, fonts } from "@/lib/theme";

const NOTES_DIR = "notes";

/**
 * Sanitize a string to be used as a filename.
 * Removes or replaces characters that are invalid in filenames.
 * Preserves spaces for readability (supported on iOS/Android/macOS).
 */
function sanitizeFilename(title: string): string {
  // Replace invalid filename characters with dashes
  // Invalid chars: / \ : * ? " < > |
  let sanitized = title.replace(/[/\\:*?"<>|]/g, "-");

  // Collapse multiple spaces into single space
  sanitized = sanitized.replace(/\s+/g, " ");

  // Remove leading/trailing spaces and dots
  sanitized = sanitized.replace(/^[\s.]+|[\s.]+$/g, "");

  // Limit length to 100 characters
  sanitized = sanitized.slice(0, 100);

  // If empty after sanitization, use a default name
  if (!sanitized) {
    sanitized = "Untitled";
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
  const notes = useNotesStore((state) => state.notes);
  const setNotes = useNotesStore((state) => state.setNotes);
  const searchIndex = useNotesStore((state) => state.searchIndex);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const currentFileRef = useRef<File | null>(null);
  const originalIdRef = useRef<string>("");
  const originalTextRef = useRef<string>("");
  const originalTitleRef = useRef<string>("");
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleScrollBegin = () => {
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = null;
    }
    setIsScrolling(true);
  };

  const handleScrollEnd = () => {
    // Delay re-enabling input to prevent accidental focus
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, 150);
  };

  useEffect(() => {
    loadNote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Update the header with editable title
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TextInput
          style={styles.headerTitleInput}
          value={title}
          onChangeText={setTitle}
          selectTextOnFocus
          placeholder="Untitled"
          placeholderTextColor={colors.textTertiary}
        />
      ),
    });
  }, [title, navigation]);

  // Only save if content or title has actually changed from original
  useEffect(() => {
    if (isLoaded && (text !== originalTextRef.current || title !== originalTitleRef.current)) {
      saveNote();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, title, isLoaded]);

  const loadNote = useCallback(async () => {
    try {
      if (id === "new") {
        // Creating a new note - start with "Untitled"
        const newTitle = "Untitled";
        setTitle(newTitle);
        originalIdRef.current = "";
        originalTextRef.current = "";
        originalTitleRef.current = newTitle;
        setIsLoaded(true);
        return;
      }

      const notesDir = getNotesDirectory();
      // Try the filename as-is first, then try URL-encoded version for legacy files
      let noteFile = new File(notesDir, `${id}.md`);
      if (!noteFile.exists) {
        // Try with URL-encoded filename (for files imported from Obsidian with %20)
        const encodedFilename = encodeURIComponent(id) + ".md";
        noteFile = new File(notesDir, encodedFilename);
      }

      if (noteFile.exists) {
        const content = await noteFile.text();
        currentFileRef.current = noteFile;
        originalIdRef.current = id;
        originalTextRef.current = content;
        originalTitleRef.current = id;
        setText(content);
        setTitle(id);
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
      const newId = sanitizeFilename(title);
      const filename = newId + ".md";
      const newFile = new File(notesDir, filename);

      const oldId = originalIdRef.current || newId;
      const isRename =
        currentFileRef.current && currentFileRef.current.uri !== newFile.uri;

      // If the filename changed and we have an existing file, delete the old one
      if (isRename) {
        if (currentFileRef.current!.exists) {
          currentFileRef.current!.delete();
        }
      }

      // Write the content to the new file
      if (!newFile.exists) {
        newFile.create();
      }
      newFile.write(text);
      currentFileRef.current = newFile;

      const modificationTime = Date.now();

      // Update search index and store
      if (searchIndex) {
        let updatedPreviews;
        if (isRename && oldId !== newId) {
          updatedPreviews = renameNoteInIndex(
            searchIndex,
            oldId,
            newId,
            text,
            modificationTime,
            notes,
          );
        } else {
          updatedPreviews = updateNoteInIndex(
            searchIndex,
            newId,
            text,
            modificationTime,
            notes,
          );
        }
        setNotes(updatedPreviews);
      }

      // Update refs so we don't re-save unchanged content
      originalIdRef.current = newId;
      originalTextRef.current = text;
      originalTitleRef.current = title;
    } catch (error) {
      console.error("Error saving note:", error);
    }
  }, [text, title, searchIndex, notes, setNotes]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={handleScrollBegin}
        onScrollEndDrag={handleScrollEnd}
        onMomentumScrollBegin={handleScrollBegin}
        onMomentumScrollEnd={handleScrollEnd}
      >
        <MarkdownTextInput
          value={text}
          onChangeText={setText}
          style={styles.input}
          multiline
          parser={parseMarkdown}
          placeholder="Start typing your note..."
          placeholderTextColor={colors.textTertiary}
          autoFocus={id === "new"}
          scrollEnabled={false}
          pointerEvents={isScrolling ? "none" : "auto"}
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
  headerTitleInput: {
    fontFamily: fonts.display.semiBold,
    fontSize: 18,
    color: colors.textPrimary,
    minWidth: 200,
    textAlign: "left",
    letterSpacing: -0.2,
  },
  input: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
    color: colors.textPrimary,
  },
});
