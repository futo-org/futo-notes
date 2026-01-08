import { Directory, File, Paths } from "expo-file-system";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, TextInput as TextInputType, View, LayoutChangeEvent } from "react-native";
import { useNotesStore } from "@/lib/notesStore";
import { renameNoteInIndex, updateNoteInIndex } from "@/lib/notesLoader";
import { usePersistentEditor } from "@/lib/PersistentEditor";
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

// Performance timing - tracks note opening latency
const PERF_LOGGING = __DEV__ || true; // Enable in release for testing
let noteOpenStartTime: number | null = null;

function logPerf(label: string) {
  if (!PERF_LOGGING || noteOpenStartTime === null) return;
  const elapsed = Date.now() - noteOpenStartTime;
  console.log(`[PERF] ${label}: ${elapsed}ms`);
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
  const titleDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const titleInputRef = useRef<TextInputType>(null);
  const setTitleRef = useRef(setTitle);
  const editorContainerRef = useRef<View>(null);

  // Get persistent editor
  const editor = usePersistentEditor();

  // Start timing when component mounts
  useEffect(() => {
    noteOpenStartTime = Date.now();
    logPerf("NoteScreen mounted");
    return () => {
      noteOpenStartTime = null;
    };
  }, []);

  // Callback when editor is ready
  const handleEditorReady = useCallback(() => {
    logPerf("Editor ready (content visible)");
    noteOpenStartTime = null; // Reset for next open
  }, []);

  // Track when we have a valid layout (header is visible)
  const [hasValidLayout, setHasValidLayout] = useState(false);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Measure container and update persistent editor layout
  const handleContainerLayout = useCallback((_event: LayoutChangeEvent) => {
    // Debounce measurements to get stable final layout
    if (layoutTimerRef.current) {
      clearTimeout(layoutTimerRef.current);
    }
    layoutTimerRef.current = setTimeout(() => {
      editorContainerRef.current?.measureInWindow((windowX, windowY, windowWidth, windowHeight) => {
        // Only accept layout if y > 40 (header must be present)
        if (windowY > 40) {
          // Add offset to avoid covering the header (edge-to-edge mode shifts things)
          const headerOffset = 30;
          console.log(`[NoteScreen] Layout stable: y=${windowY} + ${headerOffset}, h=${windowHeight - headerOffset}`);
          editor.setTargetLayout({
            x: windowX,
            y: windowY + headerOffset,
            width: windowWidth,
            height: windowHeight - headerOffset,
          });
          setHasValidLayout(true);
        } else {
          console.log(`[NoteScreen] Layout not ready: y=${windowY}`);
        }
      });
    }, 150);
  }, [editor]);

  // Keep setTitleRef in sync
  useEffect(() => {
    setTitleRef.current = setTitle;
  }, [setTitle]);

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
        logPerf("File read complete");
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
      logPerf("Content loaded, rendering editor");
    }
  }, [id]);

  const saveNote = useCallback(async () => {
    try {
      const notesDir = getNotesDirectory();
      // Use original title if current title is empty (prevents accidental renames)
      const effectiveTitle =
        title.trim() || originalTitleRef.current || "Untitled";
      const newId = sanitizeFilename(effectiveTitle);
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

  // Load note on mount
  useEffect(() => {
    loadNote();
  }, [id, loadNote]);

  // Set up the header with editable title - only once to avoid cursor issues
  useEffect(() => {
    navigation.setOptions({
      headerTitle: () => (
        <TextInput
          ref={titleInputRef}
          style={styles.headerTitleInput}
          defaultValue=""
          onChangeText={(text) => setTitleRef.current(text)}
          selectTextOnFocus
          placeholder="Untitled"
          placeholderTextColor={colors.textTertiary}
        />
      ),
    });
  }, [navigation]);

  // Sync title to TextInput - runs when loaded and when title changes
  // This ensures the input value is correct even if navigation recreates the header
  useEffect(() => {
    if (isLoaded && titleInputRef.current) {
      titleInputRef.current.setNativeProps({ text: title });
    }
  }, [isLoaded, title]);

  // Save text changes immediately (but only if text changed)
  useEffect(() => {
    if (isLoaded && text !== originalTextRef.current) {
      saveNote();
    }
  }, [text, isLoaded, saveNote]);

  // Activate persistent editor when content is loaded AND layout is valid
  const hasActivatedRef = useRef(false);
  useEffect(() => {
    if (isLoaded && hasValidLayout && !hasActivatedRef.current) {
      hasActivatedRef.current = true;
      logPerf("Activating persistent editor");
      editor.setOnReady(handleEditorReady);
      // Use originalTextRef to get the initial content (not reactive text state)
      editor.activate(originalTextRef.current, setText, { autoFocus: id === "new" });
    }

    // Deactivate on unmount
    return () => {
      if (hasActivatedRef.current) {
        editor.deactivate();
        hasActivatedRef.current = false;
      }
    };
  }, [isLoaded, hasValidLayout, editor, id, handleEditorReady]);

  // Cleanup layout timer on unmount
  useEffect(() => {
    return () => {
      if (layoutTimerRef.current) {
        clearTimeout(layoutTimerRef.current);
      }
    };
  }, []);

  // Debounce title changes to avoid rapid saves
  useEffect(() => {
    if (isLoaded && title !== originalTitleRef.current) {
      // Clear any existing timer
      if (titleDebounceTimerRef.current) {
        clearTimeout(titleDebounceTimerRef.current);
      }

      // Set a new timer to save after 500ms of inactivity
      titleDebounceTimerRef.current = setTimeout(() => {
        saveNote();
      }, 500);
    }

    // Cleanup timer on unmount
    return () => {
      if (titleDebounceTimerRef.current) {
        clearTimeout(titleDebounceTimerRef.current);
      }
    };
  }, [title, isLoaded, saveNote]);

  // Don't render editor until content is loaded
  if (!isLoaded) {
    return <View style={styles.container} />;
  }

  // Render a placeholder that the persistent editor will overlay
  return (
    <View
      ref={editorContainerRef}
      style={styles.container}
      onLayout={handleContainerLayout}
    >
      {/* The persistent editor WebView overlays this container */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  headerTitleInput: {
    fontFamily: fonts.display.semiBold,
    fontSize: 18,
    color: colors.textPrimary,
    minWidth: 200,
    textAlign: "left",
    letterSpacing: -0.2,
  },
});
