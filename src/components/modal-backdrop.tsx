// components/modal-backdrop.tsx
// Reusable animated backdrop for form modals (Add Room, Add Box, Edit, etc.)
// Provides the same fade-in + spring scale animation used in ConfirmModal.
//
// Usage:
//   <Modal visible transparent animationType="none">
//     <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
//       <ModalBackdrop visible={visible} onBackdropPress={onCancel}>
//         <View style={card}>
//           <Text>...</Text>
//           <TextInput />
//           <Button>Save</Button>
//         </View>
//       </ModalBackdrop>
//     </KeyboardAvoidingView>
//   </Modal>

import { useEffect, useRef } from 'react';
import {
  Animated,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

// ──────────────────────────────────────────
// Props
// ──────────────────────────────────────────

interface ModalBackdropProps {
  /** Whether the parent modal is visible (triggers animation) */
  visible: boolean;
  /** Called when the user taps outside the card */
  onBackdropPress?: () => void;
  /** Card content (form, buttons, etc.) */
  children: React.ReactNode;
}

// ──────────────────────────────────────────
// Component
// ──────────────────────────────────────────

export default function ModalBackdrop({
  visible,
  onBackdropPress,
  children,
}: ModalBackdropProps) {
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scaleAnim, {
          toValue: 1,
          tension: 200,
          friction: 12,
          useNativeDriver: true,
        }),
      ]).start();
    } else {
      fadeAnim.setValue(0);
      scaleAnim.setValue(0.92);
    }
  }, [visible, fadeAnim, scaleAnim]);

  return (
    <Animated.View style={[styles.backdrop, { opacity: fadeAnim }]}>
      {onBackdropPress && (
        <Pressable style={StyleSheet.absoluteFill} onPress={onBackdropPress} />
      )}
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        {children}
      </Animated.View>
    </Animated.View>
  );
}

// ──────────────────────────────────────────
// Styles
// ──────────────────────────────────────────

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,22,0.45)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
});
