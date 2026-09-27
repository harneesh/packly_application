// components/bottom-sheet.tsx
// Shared drag-to-dismiss bottom sheet for Packly.
//
// Pulling the sheet down translates it and fades the backdrop proportionally,
// so the screen behind gradually becomes visible — the shadow "goes off" as
// you drag. Releasing past ~30% of the screen height (or flinging downward)
// dismisses the sheet; otherwise it springs back to the top.
//
// Built on core Animated + PanResponder (no extra native deps) so it behaves
// identically on iOS, Android, and web. All bottom sheets in the app use this
// component so the interaction is consistent everywhere.

import { createContext, useContext, useEffect, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
  type PanResponderInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../../packly-ui/theme';

/**
 * Context that exposes the sheet's pan responders so child elements can opt
 * into being part of the drag target (e.g. a sheet title).
 */
const BottomSheetDragContext = createContext<{
  drag: PanResponderInstance; // claims after a clear downward move (tap-safe)
  grab: PanResponderInstance; // claims the touch immediately (always drags)
} | null>(null);

/**
 * Wrap any element inside a BottomSheet to make it part of the drag target.
 * The wrapped element responds to drag gestures exactly like the handle bar
 * does — pulling down dismisses the sheet. Give it the same footprint as the
 * title/header it wraps (padding etc. stay in the child's own styles), which
 * is what makes swiping-to-dismiss easy on action sheets whose rows would
 * otherwise swallow the gesture.
 */
export function BottomSheetDraggableArea({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const responders = useContext(BottomSheetDragContext);
  return (
    <View
      style={style}
      {...(responders?.drag.panHandlers ?? {})}
      {...(responders?.grab.panHandlers ?? {})}>
      {children}
    </View>
  );
}

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** Extra styles for the sheet card (background, maxHeight, …). */
  sheetStyle?: StyleProp<ViewStyle>;
  /** Show the grabber handle at the top of the sheet (default true). */
  showHandle?: boolean;
  /**
   * Restrict the drag to the handle area only. Use for sheets whose content
   * scrolls vertically (a ScrollView would otherwise steal the gesture).
   * Default false — the whole sheet is draggable.
   */
  handleOnly?: boolean;
}

export default function BottomSheet({
  visible,
  onClose,
  children,
  sheetStyle,
  showHandle = true,
  handleOnly = false,
}: BottomSheetProps) {
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const translateY = useRef(new Animated.Value(windowHeight)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const dismissing = useRef(false);

  // The responders are created once, so anything they need at gesture time is
  // read from a ref that is refreshed every render (no stale closures).
  const settings = useRef({ handleOnly, windowHeight, onClose });
  settings.current = { handleOnly, windowHeight, onClose };

  // Two responders with identical move/release logic:
  //   • handlePanResponder — claims the touch immediately, so the grabber is
  //     ALWAYS a reliable drag surface on every sheet (even ones whose content
  //     is nothing but Pressables, which can swallow a move-based gesture).
  //   • bodyPanResponder  — claims only after a clear downward move, so taps on
  //     rows still work; used for whole-sheet dragging when handleOnly is off.
  const makeResponder = (grabOnStart: boolean) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => grabOnStart,
      onMoveShouldSetPanResponder: (_evt, g) =>
        grabOnStart ||
        (!settings.current.handleOnly && g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx)),
      onPanResponderMove: (_evt, g) => {
        if (dismissing.current) return;
        const y = Math.max(0, g.dy);
        const distance = settings.current.windowHeight * 0.3;
        translateY.setValue(y);
        // Backdrop fades out as the sheet goes down — the screen behind
        // becomes visible gradually instead of staying hidden until release.
        backdropOpacity.setValue(Math.max(0, 1 - y / distance));
      },
      onPanResponderRelease: (_evt, g) => {
        if (dismissing.current) return;
        const y = Math.max(0, g.dy);
        const distance = settings.current.windowHeight * 0.3;
        if (y > distance || g.vy > 0.8) {
          dismissing.current = true;
          Animated.parallel([
            Animated.timing(translateY, {
              toValue: settings.current.windowHeight,
              duration: 180,
              useNativeDriver: true,
            }),
            Animated.timing(backdropOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
          ]).start(() => settings.current.onClose());
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
            Animated.timing(backdropOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
          ]).start();
        }
      },
      onPanResponderTerminate: () => {
        // Gesture stolen (e.g. by a nested modal) — snap back to rest.
        if (dismissing.current) return;
        Animated.parallel([
          Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
          Animated.timing(backdropOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
        ]).start();
      },
    });

  const handlePanResponder = useRef(makeResponder(true)).current;
  const bodyPanResponder = useRef(makeResponder(false)).current;

  const dragContextValue = useRef({ drag: bodyPanResponder, grab: handlePanResponder }).current;

  // Slide the sheet up + fade the backdrop in on open.
  useEffect(() => {
    if (visible) {
      dismissing.current = false;
      translateY.setValue(windowHeight);
      backdropOpacity.setValue(0);
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true, tension: 65, friction: 11 }),
        Animated.timing(backdropOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, translateY, backdropOpacity, windowHeight]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
        <Pressable style={styles.dismissArea} onPress={onClose} />
        <BottomSheetDragContext.Provider value={dragContextValue}>
          <Animated.View
            style={[styles.sheet, sheetStyle, { paddingBottom: insets.bottom + spacing.xxl, transform: [{ translateY }] }]}
            {...(handleOnly ? {} : bodyPanResponder.panHandlers)}>
            {showHandle && (
              <View style={styles.handleRow} {...handlePanResponder.panHandlers}>
                <View style={styles.handle} />
              </View>
            )}
            {children}
          </Animated.View>
        </BottomSheetDragContext.Provider>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(20,20,22,0.45)',
    justifyContent: 'flex-end',
  },
  dismissArea: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderCurve: 'continuous',
    paddingBottom: spacing.xxl,
    maxHeight: '85%',

    // NOTE: no shadow/elevation here. On Android, elevation shadows are drawn
    // at the card's laid-out bounds and do NOT follow the translateY transform,
    // so while the sheet is dragged down a shadow "ghost" of the card remains
    // at its original position — visible behind the fading backdrop. The card
    // sits flush at the bottom edge, so a shadow adds little visually anyway.
  },
  handleRow: {
    alignItems: 'center',
    paddingTop: spacing.lg,
    paddingBottom: spacing.xs,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
});
