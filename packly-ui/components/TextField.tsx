// components/TextField.tsx
import React, { forwardRef } from 'react';
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
        style={styles.input}
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
  label: { fontSize: 13, fontWeight: '700', color: colors.textPrimary, marginBottom: spacing.sm },
  input: {
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
    height: 56,
    fontSize: 16,
    fontFamily: fonts.regular,
    color: colors.textPrimary,
  },
  count: { alignSelf: 'flex-end', fontSize: 12, color: colors.textTertiary, marginTop: spacing.xs },
});
