import { Directory, File } from "expo-file-system";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SearchBar } from "@/components/SearchBar";
import { SwipeableNoteItem } from "@/components/SwipeableNoteItem";
import { NotePreview, useNotesStore } from "@/lib/notesStore";
import { useSearch, SearchResult } from "@/lib/useSearch";
import { loadNotesWithIndex, removeNoteFromIndex } from "@/lib/notesLoader";
import { colors, fonts, shadows, spacing, radius } from "@/lib/theme";
import { haptics } from "@/lib/haptics";
import { getNotesDirectory } from "@/lib/fileSystem";

/**
 * DEBUG: Import test notes from /sdcard/Download/fake-notes
 */
async function importTestNotes(): Promise<number> {
  const paths = [
    "file:///data/local/tmp/fake-notes",
    "/data/local/tmp/fake-notes",
  ];

  let source: Directory | null = null;
  for (const p of paths) {
    const dir = new Directory(p);
    if (dir.exists) {
      source = dir;
      break;
    }
  }

  const dest = getNotesDirectory();

  if (!source) {
    console.log(
      "Source directory not found. Push notes with: adb push /path/to/notes/. /data/local/tmp/fake-notes/"
    );
    return 0;
  }

  const items = source.list();
  let count = 0;

  for (const item of items) {
    if (item instanceof File && item.uri.endsWith(".md")) {
      try {
        const content = await item.text();
        const rawFilename = item.uri.split("/").pop()!;
        // Decode URL-encoded filename (e.g., %20 → space)
        const filename = decodeURIComponent(rawFilename);
        const newFile = new File(dest, filename);
        newFile.write(content);
        count++;
        if (count % 500 === 0) console.log(`Imported ${count} notes...`);
      } catch (e) {
        console.error("Failed to import:", item.uri, e);
      }
    }
  }

  console.log(`Import complete: ${count} notes`);
  return count;
}

const SEARCH_DEBOUNCE_MS = 300;

export default function NotesListScreen() {
  const notes = useNotesStore((state) => state.notes);
  const setNotes = useNotesStore((state) => state.setNotes);
  const searchIndex = useNotesStore((state) => state.searchIndex);
  const setSearchIndex = useNotesStore((state) => state.setSearchIndex);
  const searchQuery = useNotesStore((state) => state.searchQuery);
  const setSearchQuery = useNotesStore((state) => state.setSearchQuery);
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null
  );
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { search } = useSearch();

  const loadNotes = useCallback(async () => {
    try {
      const { previews, searchIndex: index } = await loadNotesWithIndex();
      setNotes(previews);
      setSearchIndex(index);
    } catch (error) {
      console.error("Error loading notes:", error);
    }
  }, [setNotes, setSearchIndex]);

  // Load notes and search index on mount
  useEffect(() => {
    if (notes.length === 0 && !searchIndex) {
      loadNotes();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openNote = useCallback(
    (id: string) => {
      router.push(`/note/${encodeURIComponent(id)}`);
    },
    [router]
  );

  const deleteNote = useCallback(
    (id: string) => {
      try {
        const notesDir = getNotesDirectory();
        const file = new File(notesDir, `${encodeURIComponent(id)}.md`);
        if (file.exists) {
          file.delete();
        }

        // Update search index
        if (searchIndex) {
          const updatedPreviews = removeNoteFromIndex(searchIndex, id, notes);
          setNotes(updatedPreviews);
        }
      } catch (error) {
        console.error("Error deleting note:", error);
      }
    },
    [searchIndex, notes, setNotes]
  );

  const createNewNote = () => {
    haptics.softTap();
    router.push("/note/new");
  };

  // Debounced search - now synchronous since index is pre-built
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

      searchTimeoutRef.current = setTimeout(() => {
        const results = search(query);
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

  const renderNoteItem = useCallback(
    ({ item }: { item: NotePreview }) => (
      <SwipeableNoteItem
        item={item}
        onPress={openNote}
        onDelete={deleteNote}
      />
    ),
    [openNote, deleteNote]
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
      />
      {searchQuery.trim() && searchResults?.length === 0 && (
        <View style={styles.noResults}>
          <Text style={styles.noResultsText}>No matching notes found</Text>
        </View>
      )}
      <FlashList
        data={displayedNotes}
        keyExtractor={(item) => item.id}
        renderItem={renderNoteItem}
        extraData={notes.length}
        maintainVisibleContentPosition={{ disabled: true }}
        drawDistance={500}
        contentContainerStyle={
          displayedNotes.length === 0 && !searchQuery.trim()
            ? styles.emptyList
            : styles.listContent
        }
        ListEmptyComponent={!searchQuery.trim() ? renderEmptyList : null}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
      />
      <Pressable
        style={({ pressed }) => [
          styles.fab,
          { bottom: spacing.xl + insets.bottom },
          pressed && styles.fabPressed,
        ]}
        onPress={createNewNote}
        onLongPress={async () => {
          console.log("Starting import...");
          const count = await importTestNotes();
          console.log(`Imported ${count} notes, reloading...`);
          loadNotes();
        }}
      >
        <Text style={styles.fabIcon}>+</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  listContent: {
    paddingBottom: spacing["4xl"],
  },
  noResults: {
    paddingVertical: spacing.xl,
    alignItems: "center",
  },
  noResultsText: {
    fontFamily: fonts.body.regular,
    fontSize: 15,
    color: colors.textTertiary,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: spacing.xl,
  },
  emptyList: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingBottom: 100,
  },
  emptyText: {
    fontFamily: fonts.display.semiBold,
    fontSize: 20,
    color: colors.textSecondary,
  },
  emptySubtext: {
    fontFamily: fonts.body.regular,
    fontSize: 15,
    color: colors.textTertiary,
    marginTop: spacing.sm,
  },
  fab: {
    position: "absolute",
    right: spacing.xl,
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    justifyContent: "center",
    alignItems: "center",
    ...shadows.lg,
  },
  fabPressed: {
    backgroundColor: colors.accentLight,
    transform: [{ scale: 0.96 }],
  },
  fabIcon: {
    fontSize: 28,
    color: colors.background,
    marginTop: -2,
    fontWeight: "300",
  },
});
