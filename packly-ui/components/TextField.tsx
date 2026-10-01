// components/TextField.tsx
import React, { forwardRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { colors, radius, spacing, fonts } from '../theme';

interface TextFieldProps {
  label?: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  maxLength?: number;
  showCount?: boolean;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoFocus?: boolean;
}

const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  {
    label,
    value,
    onChangeText,
    placeholder,
    maxLength,
    showCount,
    autoCapitalize = 'sentences',
    autoFocus,
  },
  ref,
) {
  // Visual-only focus ring (mockup §4): the field border lights up in the
  // brand indigo while typing. No behavior attached.
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.wrap}>
      {label ? <Text style={styles.label}>{label}</Text> : null}
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textTertiary}
        maxLength={maxLength}
        autoCapitalize={autoCapitalize}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[styles.input, focused && styles.inputFocused]}
      />
      {showCount && maxLength ? (
        <Text style={styles.count}>
          {value.length}/{maxLength}
        </Text>
      ) : null}
    </View>
  );
});

export default TextField;

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    fontSize: 13,
    fontFamily: fonts.bold,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  input: {
    // White field on the periwinkle canvas (mockup §4), with a hairline
    // border that turns indigo on focus.
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    // Height owns the vertical rhythm; zero padding + Android centering keeps
    // the typed text dead-centre on both platforms.
    paddingVertical: 0,
    textAlignVertical: 'center',
    height: 56,
    fontSize: 16,
    fontFamily: fonts.regular,
    color: colors.textPrimary,
    borderCurve: 'continuous',
  },
  inputFocused: {
    borderColor: colors.primary,
  },
  count: {
    alignSelf: 'flex-end',
    fontSize: 12,
    fontFamily: fonts.medium,
    color: colors.textTertiary,
    marginTop: spacing.xs,
    fontVariant: ['tabular-nums'],
  },
});
