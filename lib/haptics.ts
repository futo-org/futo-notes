/**
 * Haptic feedback utilities
 */
import * as Haptics from "expo-haptics";
import { Platform } from "react-native";

export const haptics = {
  /** Soft impact - for button presses */
  softTap: () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  },
} as const;
