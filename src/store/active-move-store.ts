import { create } from 'zustand';
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

const ACTIVE_MOVE_KEY = 'packly-active-move';
const ACTIVE_MOVE_FILE = `${FileSystem.documentDirectory}active-move.json`;

// ──────────────────────────────────────────
// Persistence helpers
// ──────────────────────────────────────────

async function saveToFile(moveId: string | null): Promise<void> {
  const data = JSON.stringify({ activeMoveId: moveId });

  if (Platform.OS === 'web') {
    if (moveId) {
      localStorage.setItem(ACTIVE_MOVE_KEY, data);
    } else {
      localStorage.removeItem(ACTIVE_MOVE_KEY);
    }
    return;
  }

  await FileSystem.writeAsStringAsync(ACTIVE_MOVE_FILE, data);
}

async function loadFromFile(): Promise<string | null> {
  if (Platform.OS === 'web') {
    const raw = localStorage.getItem(ACTIVE_MOVE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed.activeMoveId ?? null;
    } catch {
      return null;
    }
  }

  try {
    const raw = await FileSystem.readAsStringAsync(ACTIVE_MOVE_FILE);
    const parsed = JSON.parse(raw);
    return parsed.activeMoveId ?? null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────
// Store
// ──────────────────────────────────────────

interface ActiveMoveState {
  activeMoveId: string | null;
  isLoaded: boolean;
  setActiveMove: (id: string | null) => Promise<void>;
  loadActiveMove: () => Promise<void>;
}

export const useActiveMoveStore = create<ActiveMoveState>((set) => ({
  activeMoveId: null,
  isLoaded: false,

  setActiveMove: async (id: string | null) => {
    set({ activeMoveId: id });
    await saveToFile(id);
  },

  loadActiveMove: async () => {
    const id = await loadFromFile();
    set({ activeMoveId: id, isLoaded: true });
  },
}));
