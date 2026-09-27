// components/Button.tsx
import React, { useRef, useCallback } from 'react';
import { TouchableOpacity, Text, StyleSheet, ActivityIndicator, Animated, StyleProp, ViewStyle } from 'react-native';
import { colors, radius, fonts } from '../theme';

interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}

export default function Button({ label, onPress, variant = 'primary', disabled, loading, style }: ButtonProps) {
  const isPrimary = variant === 'primary';
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 0.97,
      useNativeDriver: true,
      tension: 200,
      friction: 6,
    }).start();
  }, [scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      useNativeDriver: true,
      tension: 200,
      friction: 6,
    }).start();
  }, [scaleAnim]);

  return (
    <Animated.View style={[style, { transform: [{ scale: scaleAnim }] }]}>
      <TouchableOpacity
        activeOpacity={1}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        style={[styles.base, isPrimary ? styles.primary : styles.secondary, (disabled || loading) && styles.disabled]}
      >
        {loading ? (
          <ActivityIndicator color={isPrimary ? colors.textInverse : colors.primary} />
        ) : (
          <Text style={isPrimary ? styles.primaryText : styles.secondaryText}>{label}</Text>
        )}
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 52,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderCurve: 'continuous',
  },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border },
  primaryText: { color: colors.textInverse, fontSize: 16, fontFamily: fonts.bold, fontWeight: '700' },
  secondaryText: { color: colors.textPrimary, fontSize: 16, fontFamily: fonts.bold, fontWeight: '700' },
  disabled: { opacity: 0.5 },
});
