import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { colors, fonts, spacing, radius } from "@/lib/theme";

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onClear: () => void;
  isSearching?: boolean;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChangeText,
  onClear,
  isSearching,
  placeholder = "Search notes…",
}: SearchBarProps) {
  return (
    <View style={styles.container}>
      <Ionicons
        name="search-outline"
        size={18}
        color={colors.textTertiary}
        style={styles.searchIcon}
      />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        selectionColor={colors.accent}
      />
      {isSearching ? (
        <ActivityIndicator
          size="small"
          color={colors.accent}
          style={styles.rightIcon}
        />
      ) : value ? (
        <Pressable
          onPress={onClear}
          style={({ pressed }) => [
            styles.rightIcon,
            pressed && styles.rightIconPressed,
          ]}
          hitSlop={8}
        >
          <Ionicons name="close-circle" size={18} color={colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    height: 40,
  },
  searchIcon: {
    marginRight: spacing.sm,
  },
  input: {
    fontFamily: fonts.body.regular,
    flex: 1,
    fontSize: 16,
    color: colors.textPrimary,
    paddingVertical: 0,
  },
  rightIcon: {
    marginLeft: spacing.sm,
    padding: spacing.xs,
    borderRadius: radius.full,
  },
  rightIconPressed: {
    backgroundColor: colors.border,
  },
});
