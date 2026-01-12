import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Text, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { colors, fonts } from "@/lib/theme";

// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();

function HeaderTitle({ children }: { children: string }) {
  return <Text style={styles.headerTitle}>{children}</Text>;
}

export default function RootLayout() {
  const [fontsLoaded, error] = useFonts({
    // Display fonts - Vollkorn for elegant serif headings
    "Vollkorn-Regular": require("../assets/fonts/Vollkorn-Regular.ttf"),
    "Vollkorn-Medium": require("../assets/fonts/Vollkorn-Medium.ttf"),
    "Vollkorn-SemiBold": require("../assets/fonts/Vollkorn-SemiBold.ttf"),
    "Vollkorn-Bold": require("../assets/fonts/Vollkorn-Bold.ttf"),
    "Vollkorn-Italic": require("../assets/fonts/Vollkorn-Italic.ttf"),
    // Body fonts - IBM Plex Sans
    "IBMPlexSans-Regular": require("../assets/fonts/IBMPlexSans-Regular.otf"),
    "IBMPlexSans-Medium": require("../assets/fonts/IBMPlexSans-Medium.otf"),
    "IBMPlexSans-SemiBold": require("../assets/fonts/IBMPlexSans-SemiBold.otf"),
    "IBMPlexSans-Bold": require("../assets/fonts/IBMPlexSans-Bold.otf"),
    // Mono fonts - IBM Plex Mono
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
    <GestureHandlerRootView style={styles.root}>
      <Stack
          screenOptions={{
            headerStyle: {
              backgroundColor: colors.background,
            },
            contentStyle: {
              backgroundColor: colors.background,
            },
            headerShadowVisible: true,
            statusBarStyle: "dark",
            headerTitleStyle: {
              fontFamily: fonts.display.semiBold,
              fontSize: 18,
              color: colors.textPrimary,
            },
            headerTintColor: colors.textSecondary,
          }}
        >
          <Stack.Screen
            name="index"
            options={{
              headerTitle: () => <HeaderTitle>Notes</HeaderTitle>,
              headerShadowVisible: false, // Shadow is on SearchBar instead
            }}
          />
          <Stack.Screen
            name="note/[id]"
            options={{
              title: "",
              // Fast fade animation for budget devices
              animation: "fade",
              animationDuration: 150,
            }}
          />
      </Stack>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  headerTitle: {
    fontFamily: fonts.display.semiBold,
    fontSize: 22,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
});
