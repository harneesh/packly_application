// services/recent-searches.ts
// Local persistence for recent search terms (max 8, most recent first).
// Uses the same platform-aware pattern as active-move-store.ts:
//   - native → expo-file-system/legacy JSON file
//   - web    → localStorage
// No async storage dependency needed.

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

// ──────────────────────────────────────────
// Constants
// ──────────────────────────────────────────

const RECENT_KEY = 'packly-recent-searches';
const RECENT_FILE = `${FileSystem.documentDirectory}recent-searches.json`;
const MAX_RECENT = 8;

// ──────────────────────────────────────────
// Persistence helpers
// ──────────────────────────────────────────

async function saveToFile(terms: string[]): Promise<void> {
  const data = JSON.stringify({ terms });

  if (Platform.OS === 'web') {
    localStorage.setItem(RECENT_KEY, data);
    return;
  }

  await FileSystem.writeAsStringAsync(RECENT_FILE, data);
}

async function loadFromFile(): Promise<string[]> {
  if (Platform.OS === 'web') {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.terms) ? parsed.terms.filter((t: unknown) => typeof t === 'string') : [];
    } catch {
      return [];
    }
  }

  try {
    const raw = await FileSystem.readAsStringAsync(RECENT_FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.terms) ? parsed.terms.filter((t: unknown) => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

// ──────────────────────────────────────────
// Public API
// ──────────────────────────────────────────

/** Load saved recent search terms (most recent first). */
export async function loadRecentSearches(): Promise<string[]> {
  return loadFromFile();
}

/**
 * Add a term to the top of the recent list (deduped case-insensitively),
 * capped at MAX_RECENT. Returns the updated list.
 */
export async function addRecentSearch(term: string): Promise<string[]> {
  const trimmed = term.trim();
  if (!trimmed) return loadFromFile();

  const current = await loadFromFile();
  const next = [
    trimmed,
    ...current.filter((t) => t.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, MAX_RECENT);

  await saveToFile(next);
  return next;
}

/** Clear all recent searches. */
export async function clearRecentSearches(): Promise<void> {
  await saveToFile([]);
}
