// theme.ts
// Central design tokens for Packly. Import these instead of hardcoding
// colors, spacing, or font sizes so every screen stays visually consistent.
//
// Typography: Poppins (bundled via @expo-google-fonts/poppins) is the app
// font on every platform. All font tokens and every weighted Text style MUST
// set an explicit fontFamily from `fonts` below, otherwise the platform
// default (Roboto) leaks through.
//
// Palette (2026 redesign — matches the designer mockups):
//   • Periwinkle app background with white cards
//   • Indigo primary (chips, FAB, buttons)
//   • Dark navy "progress card" with a yellow accent (corner fold + bar)
//   • Kraft/tan box tiles with a yellow lid
//   • Pill status colors: packed (green) / packing (amber) / empty (gray)

/**
 * Explicit font families — use these on every Text/TextInput style.
 * These are the names the weights are registered under by useFonts() in
 * src/app/_layout.tsx (the @expo-google-fonts exports themselves are asset
 * sources, not family names).
 */
export const fonts = {
  regular: 'Poppins_400Regular',
  medium: 'Poppins_500Medium',
  semiBold: 'Poppins_600SemiBold',
  bold: 'Poppins_700Bold',
  extraBold: 'Poppins_800ExtraBold',
  italic: 'Poppins_400Regular_Italic',
} as const;

const { regular, medium, semiBold, bold, extraBold } = fonts;

export const colors = {
  // Backgrounds
  // Periwinkle app canvas; cards stay white.
  background: '#E9ECF7',
  surface: '#FFFFFF',
  surfaceMuted: '#F1F2FA',

  // Dark navy hero card (progress summary) + deep fold shade
  navy: '#232347',
  navyDeep: '#1B1B3A',

  // Yellow accent — progress card corner fold, progress bar, kraft lid
  accent: '#F5C445',
  accentDeep: '#E9A83A',

  // Text
  textPrimary: '#171A2E',
  textSecondary: '#5C6178',
  textTertiary: '#9AA0B4',
  textInverse: '#FFFFFF',
  // Muted text on the navy card
  textOnNavy: '#C9CCE4',

  // Translucent ink scrim (textPrimary at 45%) behind every modal, sheet and
  // photo overlay. Tokenized so screens never hand-roll rgba() values.
  scrim: 'rgba(23,26,46,0.45)',

  // Borders
  border: '#E3E5F0',
  divider: '#EFF0F7',
  // A step darker than `border` — for separators that must stay visible
  // against white/near-white backgrounds (e.g. settings section lines).
  dividerStrong: '#D4D7E4',

  // Brand
  primary: '#4F46E5',
  primaryPressed: '#4338CA',
  primarySoft: '#EEF0FE',

  // Category accents — used only for the leading "logo" icons
  move: '#E9A83A',
  moveSoft: '#FDF0D7',
  room: '#0EA5A0',
  roomSoft: '#E3F8F6',
  // Kraft cardboard tile for boxes
  box: '#DCA05E',
  boxSoft: '#F7E3C8',
  kraftLid: '#F0B33A',
  kraftText: '#7C5321',
  item: '#8B5CF6',
  itemSoft: '#F2EDFE',

  // Status pills on box rows
  packed: '#2F9E5F',
  packedSoft: '#DFF4E6',
  packing: '#C07C1D',
  packingSoft: '#FBF0DB',
  empty: '#8A90A6',
  emptySoft: '#EDF0F6',

  // Status
  success: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  dangerSoft: '#FEE2E2',

  owner: '#4F46E5',
  ownerSoft: '#EEF0FE',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  pill: 999,
};

export const font = {
  largeTitle: { fontSize: 30, fontFamily: extraBold, fontWeight: '800' as const, letterSpacing: -0.4, color: colors.textPrimary },
  title: { fontSize: 22, fontFamily: extraBold, fontWeight: '800' as const, letterSpacing: -0.3, color: colors.textPrimary },
  headline: { fontSize: 17, fontFamily: semiBold, fontWeight: '600' as const, color: colors.textPrimary },
  headlineBold: { fontSize: 17, fontFamily: bold, fontWeight: '700' as const, color: colors.textPrimary },
  body: { fontSize: 15, fontFamily: regular, fontWeight: '400' as const, color: colors.textPrimary },
  bodyMedium: { fontSize: 15, fontFamily: medium, fontWeight: '500' as const, color: colors.textPrimary },
  caption: { fontSize: 13, fontFamily: medium, fontWeight: '500' as const, color: colors.textSecondary },
  eyebrow: { fontSize: 12, fontFamily: bold, fontWeight: '700' as const, letterSpacing: 0.8, color: colors.textTertiary },
};

export const shadow = {
  card: {
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 1,
  },
};
