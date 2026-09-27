// Install WebCrypto globals (crypto.subtle, TextEncoder, btoa) backed by
// expo-crypto BEFORE creating the client, so supabase-js can use the PKCE
// S256 code challenge instead of falling back to `plain` + a warning.
import './webcrypto';
import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. ' +
    'Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in your .env file.'
  );
}

// Auth options follow the official Supabase React Native quickstart:
// https://supabase.com/docs/guides/auth/quickstarts/react-native
// - flowType: 'pkce' — REQUIRED for mobile. The default is 'implicit', which
//   returns session tokens in the URL fragment instead of an exchangeable code,
//   so exchangeCodeForSession() in auth-service.ts would have nothing to exchange.
// - detectSessionInUrl: false — there is no window.location on native, so the
//   client must not try to read tokens out of the initial URL.
// - persistSession / autoRefreshToken: true — required for a long-lived session.
// - storage: AsyncStorage — persists session to disk so the user stays signed
//   in across app restarts (killing the app, device reboot, etc.).
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
    storage: AsyncStorage,
  },
});
