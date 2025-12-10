import { Directory, File, Paths } from "expo-file-system";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SearchBar } from "@/components/SearchBar";
import { NotePreview, useNotesStore } from "@/lib/notesStore";
import { useSemanticSearch, SearchResult } from "@/lib/useSemanticSearch";

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
 * Extract preview text from note content (first ~100 chars)
 */
function getPreviewText(content: string): string {
  const preview = content.replace(/\s+/g, " ").trim();
  if (preview.length > 100) {
    return preview.slice(0, 100) + "...";
  }
  return preview || "No content";
}

const SEARCH_DEBOUNCE_MS = 300;

export default function NotesListScreen() {
  const notes = useNotesStore((state) => state.notes);
  const setNotes = useNotesStore((state) => state.setNotes);
  const searchQuery = useNotesStore((state) => state.searchQuery);
  const setSearchQuery = useNotesStore((state) => state.setSearchQuery);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null
  );
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { search, isSearching } = useSemanticSearch();

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
        (item): item is File => item instanceof File && item.uri.endsWith(".md")
      );

      const notePreviews: NotePreview[] = await Promise.all(
        mdFiles.map(async (file) => {
          const content = await file.text();
          const filename = file.uri.split("/").pop() || "";
          // Decode URL-encoded characters (e.g., %20 -> space)
          const id = decodeURIComponent(filename.replace(/\.md$/, ""));

          return {
            id,
            title: id,
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

  // Debounced search
  const handleSearchChange = useCallback(
    (query: string) => {
      setSearchQuery(query);

      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      if (!query.trim()) {
        setSearchResults(null);
        return;
      }

      searchTimeoutRef.current = setTimeout(async () => {
        const results = await search(query);
        setSearchResults(results);
      }, SEARCH_DEBOUNCE_MS);
    },
    [search, setSearchQuery]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchResults(null);
  }, [setSearchQuery]);

  // Compute displayed notes: search results or default sorted list
  const displayedNotes = useMemo(() => {
    if (!searchResults || !searchQuery.trim()) {
      return notes;
    }

    // Create a map of noteId to score
    const scoreMap = new Map(searchResults.map((r) => [r.noteId, r.score]));

    // Filter to only notes in results and sort by score
    return notes
      .filter((note) => scoreMap.has(note.id))
      .sort((a, b) => {
        const scoreA = scoreMap.get(a.id) ?? 0;
        const scoreB = scoreMap.get(b.id) ?? 0;
        return scoreB - scoreA;
      });
  }, [notes, searchResults, searchQuery]);

  const renderNoteItem = ({ item }: { item: NotePreview }) => (
    <TouchableOpacity style={styles.noteItem} onPress={() => openNote(item.id)}>
      <Text style={styles.noteTitle} numberOfLines={1}>
        {item.title}
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
      <SearchBar
        value={searchQuery}
        onChangeText={handleSearchChange}
        onClear={handleClearSearch}
        isSearching={isSearching}
      />
      {searchQuery.trim() && searchResults?.length === 0 && !isSearching && (
        <View style={styles.noResults}>
          <Text style={styles.noResultsText}>No matching notes found</Text>
        </View>
      )}
      <FlatList
        data={displayedNotes}
        keyExtractor={(item) => item.id}
        renderItem={renderNoteItem}
        contentContainerStyle={
          displayedNotes.length === 0 && !searchQuery.trim()
            ? styles.emptyList
            : undefined
        }
        ListEmptyComponent={!searchQuery.trim() ? renderEmptyList : null}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
      <Pressable
        style={[styles.fab, { bottom: 20 + insets.bottom }]}
        onPress={createNewNote}
      >
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
  noResults: {
    paddingVertical: 20,
    alignItems: "center",
  },
  noResultsText: {
    fontFamily: "IBMPlexSans-Regular",
    fontSize: 15,
    color: "#8E8E93",
  },
  noteItem: {
    padding: 16,
  },
  noteTitle: {
    fontFamily: "IBMPlexSans-SemiBold",
    fontSize: 17,
    marginBottom: 4,
  },
  notePreview: {
    fontFamily: "IBMPlexSans-Regular",
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
    fontFamily: "IBMPlexSans-SemiBold",
    fontSize: 18,
    color: "#666",
  },
  emptySubtext: {
    fontFamily: "IBMPlexSans-Regular",
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
    fontFamily: "IBMPlexSans-Regular",
    fontSize: 28,
    color: "#fff",
    marginTop: -2,
  },
});
