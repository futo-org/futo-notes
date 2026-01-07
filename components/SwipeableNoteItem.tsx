import { useCallback, useRef } from "react";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import ReanimatedSwipeable, {
  SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, {
  SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { NotePreview } from "@/lib/notesStore";
import { colors, fonts, spacing } from "@/lib/theme";

const DELETE_BUTTON_WIDTH = 80;

interface RightActionProps {
  dragX: SharedValue<number>;
  onPress: () => void;
}

function RightAction({ dragX, onPress }: RightActionProps) {
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: dragX.value + DELETE_BUTTON_WIDTH }],
  }));

  return (
    <Reanimated.View style={[styles.deleteAction, animatedStyle]}>
      <Pressable
        onPress={onPress}
        style={styles.deleteButton}
        android_ripple={{ color: "rgba(255,255,255,0.2)" }}
      >
        <Ionicons name="trash-outline" size={24} color={colors.elevated} />
      </Pressable>
    </Reanimated.View>
  );
}

interface SwipeableNoteItemProps {
  item: NotePreview;
  onPress: (id: string) => void;
  onDelete: (id: string) => void;
}

export function SwipeableNoteItem({
  item,
  onPress,
  onDelete,
}: SwipeableNoteItemProps) {
  const swipeableRef = useRef<SwipeableMethods>(null);

  const handleDelete = useCallback(() => {
    Alert.alert(
      "Delete Note",
      `Are you sure you want to delete "${item.title}"?`,
      [
        {
          text: "Cancel",
          style: "cancel",
          onPress: () => {
            swipeableRef.current?.close();
          },
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            onDelete(item.id);
          },
        },
      ],
      { cancelable: true }
    );
  }, [item.id, item.title, onDelete]);

  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, dragX: SharedValue<number>) => (
      <RightAction dragX={dragX} onPress={handleDelete} />
    ),
    [handleDelete]
  );

  return (
    <ReanimatedSwipeable
      ref={swipeableRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={renderRightActions}
      overshootRight={false}
    >
      <Pressable
        style={({ pressed }) => [
          styles.noteItem,
          pressed && styles.noteItemPressed,
        ]}
        onPress={() => onPress(item.id)}
      >
        <Text style={styles.noteTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.notePreview} numberOfLines={2}>
          {item.preview}
        </Text>
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  noteItem: {
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.background,
  },
  noteItemPressed: {
    backgroundColor: colors.surface,
  },
  noteTitle: {
    fontFamily: fonts.display.semiBold,
    fontSize: 18,
    marginBottom: spacing.xs,
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  notePreview: {
    fontFamily: fonts.body.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.textSecondary,
  },
  deleteAction: {
    backgroundColor: colors.error,
    justifyContent: "center",
    alignItems: "center",
    width: DELETE_BUTTON_WIDTH,
  },
  deleteButton: {
    justifyContent: "center",
    alignItems: "center",
    height: "100%",
    width: DELETE_BUTTON_WIDTH,
  },
});
