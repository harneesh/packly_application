import { Redirect } from 'expo-router';

/**
 * Deep-link callback route for Google OAuth (packly://auth/callback).
 *
 * The auth code is already exchanged by signInWithGoogle() in auth-service.ts
 * via the Linking listener — this route exists only so expo-router has a
 * destination for the deep link (otherwise it shows "Unmatched Route").
 * It must NOT exchange the code again: auth codes are single-use.
 *
 * Once the session is set, the (auth) layout redirects to "/" automatically.
 */
export default function AuthCallbackScreen() {
  return <Redirect href="/" />;
}
