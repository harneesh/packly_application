// components/animated-splash.tsx
// Animated logo intro that plays every time the app cold-starts.
//
// The native splash is deliberately a plain yellow screen (app.json →
// expo-splash-screen uses a transparent image): the box appears ONLY here, so
// there is never a hand-off between two differently-sized boxes and nothing
// can jump. The native splash is hidden once this overlay — same yellow — has
// laid out underneath it, so the swap is invisible.
//
// Sequence (~2.6s, all on the UI thread via Reanimated, eased curves only —
// no springs, so nothing overshoots or bounces):
//   1. the box fades in while gently growing and rising into place
//   2. the "Packly" wordmark fades up beneath it
//   3. a short, still hold so the logo can actually be seen
//   4. the overlay fades away with the box easing slightly forward,
//      revealing the app (which has been rendering underneath)
//
// With Reduce Motion on, the logo just fades in and out.

import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import Reanimated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts } from '../../packly-ui/theme';

/** Must match `expo-splash-screen` → backgroundColor in app.json. */
const SPLASH_BG = '#F5C445';
const LOGO_SIZE = 150;

// Timeline (ms).
const LOGO_IN = 900;
const WORD_DELAY = 550;
const WORD_IN = 700;
const HOLD_UNTIL = 1900;
const FADE_OUT = 650;

// Soft "ease-out-quint"-like curve for entrances, gentle in-out for the exit.
const EASE_IN_PLACE = Easing.bezier(0.22, 1, 0.36, 1);
const EASE_EXIT = Easing.bezier(0.45, 0, 0.55, 1);

interface AnimatedSplashProps {
  /** True once the app is ready to be shown (fonts, auth, cache restored). */
  ready: boolean;
  /** Called after the intro has finished and the overlay can unmount. */
  onFinish: () => void;
}

export default function AnimatedSplash({ ready, onFinish }: AnimatedSplashProps) {
  const reduceMotion = useReducedMotion();
  const [laidOut, setLaidOut] = useState(false);

  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(0.86);
  const logoLift = useSharedValue(16);
  const wordOpacity = useSharedValue(0);
  const wordLift = useSharedValue(12);
  const overlayOpacity = useSharedValue(1);

  useEffect(() => {
    if (!ready || !laidOut) return;

    // The (identical, plain yellow) overlay is painted — swap it in.
    SplashScreen.hideAsync().catch(() => {});

    const finish = (done?: boolean) => {
      'worklet';
      if (done) runOnJS(onFinish)();
    };

    if (reduceMotion) {
      logoScale.set(1);
      logoLift.set(0);
      wordLift.set(0);
      logoOpacity.set(withTiming(1, { duration: 400 }));
      wordOpacity.set(withTiming(1, { duration: 400 }));
      overlayOpacity.set(withDelay(1400, withTiming(0, { duration: 400 }, finish)));
      return;
    }

    // 1. Box eases into place.
    const enter = { duration: LOGO_IN, easing: EASE_IN_PLACE };
    logoOpacity.set(withTiming(1, { duration: LOGO_IN * 0.7, easing: Easing.out(Easing.quad) }));
    logoLift.set(withTiming(0, enter));
    logoScale.set(
      withSequence(
        withTiming(1, enter),
        // 4. ...then, after the hold, eases slightly forward as it leaves.
        withDelay(
          HOLD_UNTIL - LOGO_IN,
          withTiming(1.08, { duration: FADE_OUT, easing: EASE_EXIT }),
        ),
      ),
    );

    // 2. Wordmark fades up beneath it.
    const wordIn = { duration: WORD_IN, easing: EASE_IN_PLACE };
    wordOpacity.set(withDelay(WORD_DELAY, withTiming(1, wordIn)));
    wordLift.set(withDelay(WORD_DELAY, withTiming(0, wordIn)));

    // 3 + 4. Hold, then fade the overlay away to reveal the app.
    overlayOpacity.set(
      withDelay(HOLD_UNTIL, withTiming(0, { duration: FADE_OUT, easing: EASE_EXIT }, finish)),
    );
  }, [
    ready,
    laidOut,
    reduceMotion,
    onFinish,
    logoOpacity,
    logoScale,
    logoLift,
    wordOpacity,
    wordLift,
    overlayOpacity,
  ]);

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: overlayOpacity.get(),
  }));

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.get(),
    transform: [{ translateY: logoLift.get() }, { scale: logoScale.get() }],
  }));

  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOpacity.get(),
    transform: [{ translateY: wordLift.get() }],
  }));

  return (
    <Reanimated.View
      style={[StyleSheet.absoluteFill, styles.overlay, overlayStyle]}
      pointerEvents="none"
      onLayout={() => setLaidOut(true)}>
      <Reanimated.View style={logoStyle}>
        <Image
          source={require('../../assets/images/splash-icon.png')}
          style={styles.logo}
          resizeMode="contain"
          fadeDuration={0}
        />
      </Reanimated.View>
      <Reanimated.View style={wordStyle}>
        <Text style={styles.wordmark}>Packly</Text>
      </Reanimated.View>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    backgroundColor: SPLASH_BG,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    zIndex: 1000,
    elevation: 1000,
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
  wordmark: {
    fontSize: 34,
    fontFamily: fonts.extraBold,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: colors.navyDeep,
  },
});
