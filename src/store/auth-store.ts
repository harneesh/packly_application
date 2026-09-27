import { create } from 'zustand';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/services/supabase';
import { signInWithGoogle as googleSignIn } from '@/services/auth-service';
import { toFriendlyError } from '@/lib/errors';

interface AuthState {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  setSession: (session: Session | null) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  initialize: () => Promise<() => void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  session: null,
  isLoading: true,
  error: null,

  clearError: () => set({ error: null }),

  setSession: (session) =>
    set({
      session,
      user: session?.user ?? null,
      isLoading: false,
    }),

  signIn: async (email, password) => {
    set({ error: null, isLoading: true });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      set({ error: toFriendlyError(error, 'Failed to sign in.'), isLoading: false });
      return;
    }
    set({
      session: data.session,
      user: data.session?.user ?? null,
      isLoading: false,
    });
  },

  signInWithGoogle: async () => {
    set({ error: null, isLoading: true });
    const result = await googleSignIn();

    // User cancelled — silently return to the sign-in form, no error box.
    if (result.cancelled) {
      set({ isLoading: false });
      return;
    }

    if (!result.ok) {
      set({ error: result.error ?? 'Failed to sign in with Google.', isLoading: false });
      return;
    }

    // On success the session listener in initialize() also fires, but refresh
    // explicitly so the UI updates immediately.
    const { data } = await supabase.auth.getSession();
    set({
      session: data.session,
      user: data.session?.user ?? null,
      isLoading: false,
    });
  },

  signUp: async (name, email, password) => {
    set({ error: null, isLoading: true });
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { name } },
    });
    if (error) {
      set({ error: toFriendlyError(error, 'Failed to create account.'), isLoading: false });
      return false;
    }
    set({ isLoading: false });
    return true;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ user: null, session: null });
  },

  initialize: async () => {
    const { data } = await supabase.auth.getSession();
    set({
      session: data.session,
      user: data.session?.user ?? null,
      isLoading: false,
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      set({
        session,
        user: session?.user ?? null,
      });
    });

    return () => {
      listener?.subscription.unsubscribe();
    };
  },
}));
