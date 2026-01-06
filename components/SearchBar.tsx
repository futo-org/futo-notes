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
        color="#86868B"
        style={styles.searchIcon}
      />
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#86868B"
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
      />
      {isSearching ? (
        <ActivityIndicator
          size="small"
          color="#86868B"
          style={styles.rightIcon}
        />
      ) : value ? (
        <Pressable onPress={onClear} style={styles.rightIcon} hitSlop={8}>
          <Ionicons name="close-circle" size={18} color="#86868B" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#E8E8E6",
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
    color: "#1C1C1E",
    paddingVertical: 0,
  },
  rightIcon: {
    marginLeft: 6,
  },
});
