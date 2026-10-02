// components/auth-logo.tsx
// Packly brand mark for the Sign In / Sign Up headers: the kraft box logo on
// the brand yellow tile (same artwork as the app icon and splash).

import { Image, StyleSheet, View } from 'react-native';

import { colors, spacing, shadow } from '../../packly-ui/theme';

export default function AuthLogo() {
  return (
    <View style={styles.tile}>
      <Image
        source={require('../../assets/images/splash-icon.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    width: 76,
    height: 76,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
    borderCurve: 'continuous',
    ...shadow.card,
  },
  logo: {
    width: 54,
    height: 54,
  },
});
