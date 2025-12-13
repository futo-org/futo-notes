import { Ionicons } from "@expo/vector-icons";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";

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
  placeholder = "Search notes...",
}: SearchBarProps) {
  return (
    <View style={styles.container}>
      <Ionicons
        name="search"
        size={18}
        color="#8E8E93"
        style={styles.searchIcon}
      />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#8E8E93"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {isSearching ? (
        <ActivityIndicator
          size="small"
          color="#8E8E93"
          style={styles.rightIcon}
        />
      ) : value ? (
        <Pressable onPress={onClear} style={styles.rightIcon} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color="#8E8E93" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E5E5EA",
    borderRadius: 10,
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 8,
    height: 36,
  },
  searchIcon: {
    marginRight: 6,
  },
  input: {
    fontFamily: "IBMPlexSans-Regular",
    flex: 1,
    fontSize: 16,
    color: "#000",
    paddingVertical: 0,
  },
  rightIcon: {
    marginLeft: 6,
  },
});
