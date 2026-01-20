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
  PixelRatio,
  NativeSyntheticEvent,
  TextInputSelectionChangeEventData,
} from "react-native";
import { useNotesStore } from "@/lib/notesStore";
import { renameNoteInIndex, updateNoteInIndex } from "@/lib/notesLoader";
import { colors, fonts, radius } from "@/lib/theme";
import type { PartialMarkdownStyle } from "@expensify/react-native-live-markdown";

const NOTES_DIR = "notes";

const markdownStyle: PartialMarkdownStyle = {
  code: {
    fontFamily: fonts.mono.regular,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.codeBackground,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  pre: {
    fontFamily: fonts.mono.regular,
    fontSize: 14,
    color: colors.textPrimary,
    backgroundColor: colors.codeBlockBackground,
  },
  syntax: {
    color: colors.textTertiary,
  },
};

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
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const inputRef = useRef<any>(null);
  const selectionRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const prevTextRef = useRef<string>("");

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

  const handleTouchStart = (e: any) => {
    // Use locationX/Y which are relative to the component, more reliable across devices
    touchStartRef.current = {
      x: e.nativeEvent.locationX || e.nativeEvent.pageX,
      y: e.nativeEvent.locationY || e.nativeEvent.pageY,
    };
  };

  const handleTouchMove = (e: any) => {
    if (!touchStartRef.current) return;

    const currentX = e.nativeEvent.locationX || e.nativeEvent.pageX;
    const currentY = e.nativeEvent.locationY || e.nativeEvent.pageY;

    const dx = Math.abs(currentX - touchStartRef.current.x);
    const dy = Math.abs(currentY - touchStartRef.current.y);

    // Use PixelRatio to make threshold device-independent (roughly 5dp)
    const threshold = PixelRatio.getPixelSizeForLayoutSize(5);

    // If moved more than threshold vertically, it's a scroll gesture
    if (dy > threshold && dy > dx) {
      inputRef.current?.blur();
      setIsScrolling(true);
      touchStartRef.current = null;
    }
  };

  const handleTouchEnd = () => {
    touchStartRef.current = null;
  };

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      selectionRef.current = e.nativeEvent.selection;
    },
    []
  );

  /**
   * Handle text changes with list continuation support.
   * When Enter is pressed at the end of a list item, automatically insert the list prefix.
   */
  const handleTextChange = useCallback((newText: string) => {
    const oldText = prevTextRef.current;
    prevTextRef.current = newText;

    // Check if a single newline was just inserted
    if (newText.length === oldText.length + 1) {
      // Find where the character was inserted
      let insertPos = -1;
      for (let i = 0; i < newText.length; i++) {
        if (i >= oldText.length || newText[i] !== oldText[i]) {
          insertPos = i;
          break;
        }
      }

      if (insertPos >= 0 && newText[insertPos] === '\n') {
        // Get the line before the newline
        const lineStart = newText.lastIndexOf('\n', insertPos - 1) + 1;
        const lineBeforeNewline = newText.substring(lineStart, insertPos);

        // Check for unordered list: -, *, +
        const ulMatch = lineBeforeNewline.match(/^([ \t]*)([-*+])[ \t]+(.*)$/);
        if (ulMatch) {
          const [, indent, marker, content] = ulMatch;
          // If the line has content, continue the list
          if (content && content.trim().length > 0) {
            const prefix = `${indent}${marker} `;
            const newCursorPos = insertPos + 1 + prefix.length;
            const textWithPrefix =
              newText.substring(0, insertPos + 1) +
              prefix +
              newText.substring(insertPos + 1);
            prevTextRef.current = textWithPrefix;
            setText(textWithPrefix);
            // Set cursor position after the prefix
            setTimeout(() => {
              inputRef.current?.setSelection?.(newCursorPos, newCursorPos);
            }, 0);
            return;
          }
          // If the line is empty (just the marker), remove the marker
          if (!content || content.trim().length === 0) {
            // Remove the list marker line and the newline
            const textWithoutMarker = oldText.substring(0, lineStart) + oldText.substring(insertPos);
            prevTextRef.current = textWithoutMarker;
            setText(textWithoutMarker);
            setTimeout(() => {
              inputRef.current?.setSelection?.(lineStart, lineStart);
            }, 0);
            return;
          }
        }

        // Check for ordered list: 1., 2., etc.
        const olMatch = lineBeforeNewline.match(/^([ \t]*)(\d+)([.)])[ \t]+(.*)$/);
        if (olMatch) {
          const [, indent, num, punct, content] = olMatch;
          // If the line has content, continue the list with incremented number
          if (content && content.trim().length > 0) {
            const nextNum = parseInt(num, 10) + 1;
            const prefix = `${indent}${nextNum}${punct} `;
            const newCursorPos = insertPos + 1 + prefix.length;
            const textWithPrefix =
              newText.substring(0, insertPos + 1) +
              prefix +
              newText.substring(insertPos + 1);
            prevTextRef.current = textWithPrefix;
            setText(textWithPrefix);
            setTimeout(() => {
              inputRef.current?.setSelection?.(newCursorPos, newCursorPos);
            }, 0);
            return;
          }
          // If the line is empty (just the marker), remove the marker
          if (!content || content.trim().length === 0) {
            const textWithoutMarker = oldText.substring(0, lineStart) + oldText.substring(insertPos);
            prevTextRef.current = textWithoutMarker;
            setText(textWithoutMarker);
            setTimeout(() => {
              inputRef.current?.setSelection?.(lineStart, lineStart);
            }, 0);
            return;
          }
        }

        // Check for task list: - [ ] or - [x]
        const taskMatch = lineBeforeNewline.match(/^(\s*[-*+])\s+\[[ xX]\]\s+(.*)$/);
        if (taskMatch) {
          const [, marker, content] = taskMatch;
          if (content && content.trim().length > 0) {
            const prefix = `${marker} [ ] `;
            const newCursorPos = insertPos + 1 + prefix.length;
            const textWithPrefix =
              newText.substring(0, insertPos + 1) +
              prefix +
              newText.substring(insertPos + 1);
            prevTextRef.current = textWithPrefix;
            setText(textWithPrefix);
            setTimeout(() => {
              inputRef.current?.setSelection?.(newCursorPos, newCursorPos);
            }, 0);
            return;
          }
        }
      }
    }

    setText(newText);
  }, []);

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
        prevTextRef.current = content;
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
          ref={inputRef}
          value={text}
          onChangeText={handleTextChange}
          onSelectionChange={handleSelectionChange}
          style={styles.input}
          multiline
          parser={parseMarkdown}
          markdownStyle={markdownStyle}
          placeholder="Start typing your note..."
          placeholderTextColor={colors.textTertiary}
          autoFocus={id === "new"}
          scrollEnabled={false}
          editable={!isScrolling}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
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
