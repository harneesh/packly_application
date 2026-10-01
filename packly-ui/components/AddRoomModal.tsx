// components/AddRoomModal.tsx
import React, { useState, useRef, useEffect } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, KeyboardAvoidingView } from 'react-native';
import TextField from './TextField';
import { Ionicons } from '@expo/vector-icons';
import ModalBackdrop from '../../src/components/modal-backdrop';
import { colors, radius, spacing, font, fonts } from '../theme';

interface AddRoomModalProps {
  visible: boolean;
  onCancel: () => void;
  onAdd: (name: string) => void;
}

export default function AddRoomModal({ visible, onCancel, onAdd }: AddRoomModalProps) {
  const [name, setName] = useState('');
  const inputRef = useRef<import('react-native').TextInput>(null);

  // Auto-focus input after modal animation completes
  useEffect(() => {
    if (visible) {
      const timer = setTimeout(() => inputRef.current?.focus(), 200);
      return () => clearTimeout(timer);
    }
  }, [visible]);

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd(name.trim());
    setName('');
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ModalBackdrop visible={visible} onBackdropPress={onCancel}>
          <View style={[styles.card, { backgroundColor: colors.surface }]}>
            <View style={styles.titleRow}>
              <View style={styles.titleIcon}>
                <Ionicons name="home-outline" size={18} color={colors.primary} />
              </View>
              <Text style={font.title}>Add Room</Text>
            </View>
            <View style={{ marginTop: spacing.lg }}>
              <TextField ref={inputRef} value={name} onChangeText={setName} placeholder="e.g. Office, Garage..." maxLength={100} />
            </View>
            <View style={styles.actions}>
              <Pressable
                onPress={onCancel}
                style={({ pressed }) => [styles.pillBtn, styles.cancelBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleAdd}
                style={({ pressed }) => [styles.pillBtn, styles.addBtn, pressed && { opacity: 0.85 }]}>
                <Text style={styles.addText}>Add Room</Text>
              </Pressable>
            </View>
          </View>
        </ModalBackdrop>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    borderRadius: radius.xl,
    padding: spacing.xl,
    borderCurve: 'continuous',
    shadowColor: '#171A2E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  titleIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  // Ghost + filled pills — same action language as every other modal.
  pillBtn: {
    flex: 1,
    height: 52,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous',
  },
  cancelBtn: { borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  cancelText: { fontSize: 15, color: colors.primary, fontFamily: fonts.bold, fontWeight: '700' },
  addBtn: { backgroundColor: colors.primary },
  addText: { fontSize: 15, color: colors.textInverse, fontFamily: fonts.bold, fontWeight: '700' },
});
