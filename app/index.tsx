import { Directory, File, Paths } from "expo-file-system";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { NotePreview, useNotesStore } from "../lib/notesStore";

const NOTES_DIR = "notes";

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

/**
 * Convert filename (with underscores) to display title (with spaces)
 */
function formatDisplayTitle(filename: string): string {
  return filename.replace(/_/g, " ");
}

/**
 * Extract preview text from note content (first ~100 chars after title)
 */
function getPreviewText(content: string): string {
  const lines = content.split("\n");
  // Skip the first line (title) and get remaining content
  const restContent = lines.slice(1).join(" ").trim();
  if (restContent.length > 100) {
    return restContent.slice(0, 100) + "...";
  }
  return restContent || "No additional content";
}

export default function NotesListScreen() {
  const notes = useNotesStore((state) => state.notes);
  const setNotes = useNotesStore((state) => state.setNotes);
  const router = useRouter();

  // Reload notes from filesystem when screen comes into focus
  // This syncs filesystem -> store (handles external changes, first load, etc.)
  useFocusEffect(
    useCallback(() => {
      loadNotes();
    }, [])
  );

  const loadNotes = async () => {
    try {
      const notesDir = getNotesDirectory();
      const contents = notesDir.list();

      const mdFiles = contents.filter(
        (item): item is File =>
          item instanceof File && item.uri.endsWith(".md")
      );

      const notePreviews: NotePreview[] = await Promise.all(
        mdFiles.map(async (file) => {
          const content = await file.text();
          const filename = file.uri.split("/").pop() || "";
          const title = filename.replace(/\.md$/, "");

          return {
            id: title,
            title,
            preview: getPreviewText(content),
            modificationTime: file.modificationTime ?? 0,
          };
        })
      );

      // Sort by modification time (most recent first)
      notePreviews.sort((a, b) => b.modificationTime - a.modificationTime);
      setNotes(notePreviews);
    } catch (error) {
      console.error("Error loading notes:", error);
    }
  };

  const openNote = (id: string) => {
    router.push(`/note/${encodeURIComponent(id)}`);
  };

  const createNewNote = () => {
    router.push("/note/new");
  };

  const renderNoteItem = ({ item }: { item: NotePreview }) => (
    <TouchableOpacity style={styles.noteItem} onPress={() => openNote(item.id)}>
      <Text style={styles.noteTitle} numberOfLines={1}>
        {formatDisplayTitle(item.title)}
      </Text>
      <Text style={styles.notePreview} numberOfLines={2}>
        {item.preview}
      </Text>
    </TouchableOpacity>
  );

  const renderEmptyList = () => (
    <View style={styles.emptyContainer}>
      <Text style={styles.emptyText}>No notes yet</Text>
      <Text style={styles.emptySubtext}>Tap + to create your first note</Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <FlatList
        data={notes}
        keyExtractor={(item) => item.id}
        renderItem={renderNoteItem}
        contentContainerStyle={notes.length === 0 ? styles.emptyList : undefined}
        ListEmptyComponent={renderEmptyList}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
      <Pressable style={styles.fab} onPress={createNewNote}>
        <Text style={styles.fabText}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  noteItem: {
    padding: 16,
  },
  noteTitle: {
    fontSize: 17,
    fontWeight: "600",
    marginBottom: 4,
  },
  notePreview: {
    fontSize: 15,
    color: "#666",
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#ccc",
    marginLeft: 16,
  },
  emptyList: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#666",
  },
  emptySubtext: {
    fontSize: 14,
    color: "#999",
    marginTop: 8,
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#007AFF",
    justifyContent: "center",
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  fabText: {
    fontSize: 28,
    color: "#fff",
    fontWeight: "400",
    marginTop: -2,
  },
});
