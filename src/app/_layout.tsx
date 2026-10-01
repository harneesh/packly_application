import { Stack, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  useFonts,
  Poppins_400Regular,
  Poppins_400Regular_Italic,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
  Poppins_800ExtraBold,
} from '@expo-google-fonts/poppins';

import { Providers } from '@/services/providers';
import { useAuthStore } from '@/store/auth-store';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const isLoading = useAuthStore((state) => state.isLoading);
  // True once the persisted query cache has been read back (or failed).
  const [cacheRestored, setCacheRestored] = useState(false);

  // Poppins is the app-wide font (see packly-ui/theme.ts). Keep the native
  // splash up until the weights are loaded so no text ever renders in the
  // platform default (Roboto) first.
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_400Regular_Italic,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Poppins_800ExtraBold,
  });

  // Safety net: a slow or wedged cache read must never hold the splash —
  // after this the app opens with whatever is cached (or fetches fresh).
  useEffect(() => {
    const timer = setTimeout(() => setCacheRestored(true), 2500);
    return () => clearTimeout(timer);
  }, []);

  // The splash covers startup work: fonts + auth hydration + reading the
  // persisted query cache back, so the first visible frame is populated
  // instead of showing spinners.
  useEffect(() => {
    if (!isLoading && fontsLoaded && cacheRestored) {
      SplashScreen.hideAsync();
    }
  }, [isLoading, fontsLoaded, cacheRestored]);

  if (!fontsLoaded) {
    return null;
  }

  return (
    // Gesture Handler needs a root view above everything it drives (the
    // swipeable Settings page uses it — see app/settings.tsx).
    <GestureHandlerRootView style={{ flex: 1 }}>
      <Providers onCacheRestored={() => setCacheRestored(true)}>
        <ThemeProvider value={DefaultTheme}>
          <Stack
            screenOptions={{
              headerShown: false,
              animation: 'fade',
            }}>
            <Stack.Screen name="(auth)" />
            <Stack.Screen name="(tabs)" />
            {/* Settings is swipeable: dragging the page down closes it, which
                needs a real screen behind it to be revealed — hence a
                transparent modal (see the drag gesture in app/settings.tsx).
                The native vertical gesture is off so our drag owns the swipe. */}
            <Stack.Screen
              name="settings"
              options={{
                presentation: 'transparentModal',
                animation: 'slide_from_bottom',
                animationDuration: 200,
                gestureEnabled: false,
              }}
            />
            {/* Move Progress analytics opens from Home's progress card with the
                same swipe-down-to-close presentation as Settings (the drag
                lives in app/move-analytics.tsx). */}
            <Stack.Screen
              name="move-analytics"
              options={{
                presentation: 'transparentModal',
                animation: 'slide_from_bottom',
                animationDuration: 200,
                gestureEnabled: false,
              }}
            />
            <Stack.Screen name="faq" options={{ animation: 'slide_from_right' }} />
          </Stack>
        </ThemeProvider>
      </Providers>
    </GestureHandlerRootView>
  );
}
