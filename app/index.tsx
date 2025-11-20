import { useEffect, useState } from "react";
import { View, StyleSheet } from "react-native";
import {
  MarkdownTextInput,
  parseExpensiMark,
} from "@expensify/react-native-live-markdown";
import AsyncStorage from "@react-native-async-storage/async-storage";

const STORAGE_KEY = "@note_content";

export default function Index() {
  const [text, setText] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    loadNote();
  }, []);

  useEffect(() => {
    if (isLoaded) {
      saveNote();
    }
  }, [text, isLoaded]);

  const loadNote = async () => {
    try {
      const savedText = await AsyncStorage.getItem(STORAGE_KEY);
      if (savedText !== null) {
        setText(savedText);
      }
    } catch (error) {
      console.error("Error loading note:", error);
    } finally {
      setIsLoaded(true);
    }
  };

  const saveNote = async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, text);
    } catch (error) {
      console.error("Error saving note:", error);
    }
  };

  return (
    <View style={styles.container}>
      <MarkdownTextInput
        value={text}
        onChangeText={setText}
        style={styles.input}
        multiline
        parser={parseExpensiMark}
        placeholder="Start typing your note..."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    padding: 16,
    fontSize: 16,
    textAlignVertical: "top",
  },
});
