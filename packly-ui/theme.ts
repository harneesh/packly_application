// theme.ts
// Central design tokens for Packly. Import these instead of hardcoding
// colors, spacing, or font sizes so every screen stays visually consistent.
//
// Typography: Inter (bundled via @expo-google-fonts/inter) is the app font on
// every platform — iOS falls back to the system's native rendering while
// Android gets Inter instead of Roboto. All font tokens and every weighted
// Text style MUST set an explicit fontFamily from `fonts` below, otherwise
// the platform default (Roboto) leaks through.
//
// Each entity type (move / room / box / item) gets its own accent color,
// used for the small "logo" icon on the left of every list row.

/**
 * Explicit font families — use these on every Text/TextInput style.
 * These are the names the weights are registered under by useFonts() in
 * src/app/_layout.tsx (the @expo-google-fonts exports themselves are asset
 * sources, not family names).
 */
export const fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semiBold: 'Inter_600SemiBold',
  bold: 'Inter_700Bold',
  italic: 'Inter_400Regular_Italic',
} as const;

const { regular, medium, semiBold, bold } = fonts;

export const colors = {
  // Backgrounds
  background: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceMuted: '#F4F4F2',

  // Text
  textPrimary: '#111827',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',
  textInverse: '#FFFFFF',

  // Borders
  border: '#E5E7EB',
  divider: '#F0F0EE',

  // Brand
  primary: '#2563EB',
  primaryPressed: '#1D4ED8',
  primarySoft: '#EFF6FF',

  // Category accents — used only for the leading "logo" icons
  move: '#2563EB',
  moveSoft: '#EFF6FF',
  room: '#0EA5A0',
  roomSoft: '#E3F8F6',
  box: '#D97706',
  boxSoft: '#FEF3C7',
  item: '#8B5CF6',
  itemSoft: '#F2EDFE',

  // Status
  success: '#22C55E',
  warning: '#F59E0B',
  danger: '#EF4444',
  dangerSoft: '#FEE2E2',

  owner: '#2563EB',
  ownerSoft: '#EFF6FF',
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
  largeTitle: { fontSize: 30, fontFamily: bold, fontWeight: '700' as const, letterSpacing: -0.4, color: colors.textPrimary },
  title: { fontSize: 22, fontFamily: bold, fontWeight: '700' as const, letterSpacing: -0.3, color: colors.textPrimary },
  headline: { fontSize: 17, fontFamily: semiBold, fontWeight: '600' as const, color: colors.textPrimary },
  body: { fontSize: 15, fontFamily: regular, fontWeight: '400' as const, color: colors.textPrimary },
  bodyMedium: { fontSize: 15, fontFamily: medium, fontWeight: '500' as const, color: colors.textPrimary },
  caption: { fontSize: 13, fontFamily: medium, fontWeight: '500' as const, color: colors.textSecondary },
  eyebrow: { fontSize: 12, fontFamily: bold, fontWeight: '700' as const, letterSpacing: 0.8, color: colors.textTertiary },
};

export const shadow = {
  card: {
    shadowColor: '#0F1024',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 1,
  },
};
