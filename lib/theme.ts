/**
 * FUTO Notes Design System
 *
 * "Quiet Luxury for Thought"
 *
 * A warm, editorial aesthetic inspired by:
 * - iA Writer: Clean minimalism, distraction-free, typography-first
 * - Things 3: Muted palette (slate blues, warm creams, soft grays)
 * - Not Boring: Tactile depth, soft shadows, physical feel
 * - Instapaper: Literary reading, generous spacing, serif headings
 *
 * Typography pairing:
 * - Vollkorn (serif): Headings - warm, literary, European newspaper feel
 * - IBM Plex Sans: Body text - clean, modern, excellent readability
 * - IBM Plex Mono: Code - matching family, technical clarity
 */

/**
 * Color palette - Things 3 inspired warmth
 *
 * The palette avoids pure white/black for a softer, warmer feel.
 * Accent colors are muted blues reminiscent of quality stationery.
 */
export const colors = {
  // Backgrounds - warm paper tones
  background: "#FAF9F6", // Warm off-white, like quality paper
  surface: "#F4F1EC", // Slightly darker surface for cards/inputs
  elevated: "#FFFFFF", // Pure white for elevated elements (modals)

  // Text hierarchy - soft blacks and grays
  textPrimary: "#2C2C2C", // Soft black, not harsh
  textSecondary: "#5C5C5C", // Medium gray for secondary content
  textTertiary: "#8A8A8A", // Light gray for hints/placeholders
  textMuted: "#AEAEAE", // Very light for disabled states

  // Accent - muted slate blue (Things 3 inspired)
  accent: "#3D5A80", // Primary action color
  accentLight: "#4A6FA5", // Hover/lighter variant
  accentSubtle: "rgba(61, 90, 128, 0.08)", // Subtle backgrounds

  // Semantic - muted, not alarming
  highlight: "#8B2635", // Deep burgundy for emphasis (blockquotes)
  success: "#4A7C59", // Muted forest green
  warning: "#B8860B", // Muted gold
  error: "#A04040", // Muted red

  // Borders & separators - very subtle
  border: "#E8E4DE", // Subtle warm border
  borderLight: "#F0EDE8", // Even lighter border
  separator: "#DDD8D0", // Line separators

  // Special surfaces
  codeBackground: "#F4F1EC", // Inline code background
  codeBlockBackground: "#EBE7E0", // Code block background (darker)
  blockquoteBorder: "#C4BFB6", // Blockquote left border
};

/**
 * Typography - Font family definitions
 *
 * Vollkorn for headings brings a literary, European quality.
 * IBM Plex Sans for body ensures clean readability.
 */
export const fonts = {
  // Display/Heading font - Vollkorn (serif)
  display: {
    regular: "Vollkorn-Regular",
    medium: "Vollkorn-Medium",
    semiBold: "Vollkorn-SemiBold",
    bold: "Vollkorn-Bold",
    italic: "Vollkorn-Italic",
  },

  // Body font - IBM Plex Sans
  body: {
    regular: "IBMPlexSans-Regular",
    medium: "IBMPlexSans-Medium",
    semiBold: "IBMPlexSans-SemiBold",
    bold: "IBMPlexSans-Bold",
  },

  // Monospace font - IBM Plex Mono
  mono: {
    regular: "IBMPlexMono-Regular",
    semiBold: "IBMPlexMono-SemiBold",
  },
};

/**
 * Spacing scale - 4px base unit
 *
 * Generous spacing for a calm, uncluttered feel.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  "2xl": 24,
  "3xl": 32,
  "4xl": 40,
  "5xl": 48,
};

/**
 * Border radius scale
 *
 * Soft, friendly corners - not too rounded (playful) or sharp (harsh).
 */
export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
};

/**
 * Shadow definitions - tactile depth (Not Boring inspired)
 *
 * Soft, diffuse shadows create physicality without heaviness.
 * Multiple layers for subtle lift.
 */
export const shadows = {
  // Subtle lift - for cards, list items on hover
  sm: {
    shadowColor: "#2C2C2C",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 3,
    elevation: 1,
  },

  // Medium lift - for buttons, elevated surfaces
  md: {
    shadowColor: "#2C2C2C",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 3,
  },

  // Prominent lift - for FABs, modals
  lg: {
    shadowColor: "#2C2C2C",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 6,
  },

  // Strong lift - for floating elements
  xl: {
    shadowColor: "#2C2C2C",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 12,
  },
};

/**
 * Typography presets - ready-to-use text styles
 *
 * Combines font family, size, weight, and color for common use cases.
 */
export const typography = {
  // Headings - Vollkorn serif
  h1: {
    fontFamily: fonts.display.bold,
    fontSize: 28,
    lineHeight: 36,
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  h2: {
    fontFamily: fonts.display.semiBold,
    fontSize: 24,
    lineHeight: 32,
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  h3: {
    fontFamily: fonts.display.semiBold,
    fontSize: 20,
    lineHeight: 28,
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },

  // Body text - IBM Plex Sans
  body: {
    fontFamily: fonts.body.regular,
    fontSize: 16,
    lineHeight: 24,
    color: colors.textPrimary,
  },
  bodyMedium: {
    fontFamily: fonts.body.medium,
    fontSize: 16,
    lineHeight: 24,
    color: colors.textPrimary,
  },
  bodySmall: {
    fontFamily: fonts.body.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },

  // Labels and UI text
  label: {
    fontFamily: fonts.body.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textSecondary,
  },
  caption: {
    fontFamily: fonts.body.regular,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textTertiary,
  },

  // Code
  code: {
    fontFamily: fonts.mono.regular,
    fontSize: 14,
    lineHeight: 20,
    color: colors.textPrimary,
  },
};

/**
 * Animation timings
 *
 * Smooth, not too fast (frantic) or slow (sluggish).
 */
export const animation = {
  fast: 150,
  normal: 250,
  slow: 400,
};

