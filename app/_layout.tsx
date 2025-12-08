import { Stack } from "expo-router";
import { ActivityIndicator, View, Text, StyleSheet } from "react-native";
import { useNotesStore } from "@/lib/notesStore";

function IndexingHeaderRight() {
  const isIndexing = useNotesStore((state) => state.isIndexing);
  const indexProgress = useNotesStore((state) => state.indexProgress);

  if (!isIndexing) return null;

  return (
    <View style={styles.headerRight}>
      <ActivityIndicator size="small" color="#007AFF" />
      {indexProgress && (
        <Text style={styles.progressText}>
          {indexProgress.current}/{indexProgress.total}
        </Text>
      )}
    </View>
  );
}

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{
          title: "Notes",
          headerRight: () => <IndexingHeaderRight />,
        }}
      />
      <Stack.Screen
        name="note/[id]"
        options={{
          title: "Note",
        }}
      />
    </Stack>
  );
}

const styles = StyleSheet.create({
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    marginRight: 8,
  },
  progressText: {
    fontSize: 12,
    color: "#666",
    marginLeft: 6,
  },
});
