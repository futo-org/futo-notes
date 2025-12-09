import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack>
      <Stack.Screen
        name="index"
        options={{
          title: "Notes",
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
