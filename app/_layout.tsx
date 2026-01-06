import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { PreloadedEditorProvider } from "@/lib/PreloadedEditorContext";

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, error] = useFonts({
    "IBMPlexSans-Regular": require("../assets/fonts/IBMPlexSans-Regular.otf"),
    "IBMPlexSans-Medium": require("../assets/fonts/IBMPlexSans-Medium.otf"),
    "IBMPlexSans-SemiBold": require("../assets/fonts/IBMPlexSans-SemiBold.otf"),
    "IBMPlexSans-Bold": require("../assets/fonts/IBMPlexSans-Bold.otf"),
    "IBMPlexMono-Regular": require("../assets/fonts/IBMPlexMono-Regular.otf"),
    "IBMPlexMono-SemiBold": require("../assets/fonts/IBMPlexMono-SemiBold.otf"),
  });

  useEffect(() => {
    if (fontsLoaded || error) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, error]);

  if (!fontsLoaded && !error) {
    return null;
  }

  return (
    <PreloadedEditorProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: "#F5F5F3" },
          contentStyle: { backgroundColor: "#F5F5F3" },
          headerShadowVisible: false,
          statusBarStyle: "dark",
        }}
      >
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
    </PreloadedEditorProvider>
  );
}
