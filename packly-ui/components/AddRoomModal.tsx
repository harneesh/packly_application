// components/AddRoomModal.tsx
import React, { useState, useRef, useEffect } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import TextField from './TextField';
import Button from './Button';
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
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ModalBackdrop visible={visible} onBackdropPress={onCancel}>
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Ionicons name="home-outline" size={20} color={colors.primary} />
              <Text style={font.headline}>Add Room</Text>
            </View>
            <View style={{ marginTop: spacing.lg }}>
              <TextField ref={inputRef} value={name} onChangeText={setName} placeholder="e.g. Office, Garage..." maxLength={100} />
            </View>
            <View style={styles.actions}>
              <TouchableOpacity onPress={onCancel} style={styles.cancelBtn}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <Button label="Add" onPress={handleAdd} style={styles.addBtn} />
            </View>
          </View>
        </ModalBackdrop>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { width: '100%', backgroundColor: colors.surface, borderRadius: radius.xl, padding: spacing.xl, borderCurve: 'continuous' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: spacing.lg, gap: spacing.sm },
  cancelBtn: { paddingHorizontal: spacing.lg, height: 52, alignItems: 'center', justifyContent: 'center' },
  cancelText: { fontSize: 16, color: colors.textSecondary, fontFamily: fonts.semiBold, fontWeight: '600' },
  addBtn: { paddingHorizontal: spacing.xxl, height: 52 },
});
