// services/rooms.ts
// Room + box data access, shared by every surface that touches a room: the
// Move screen (prefetch on tap), the Room screen, and anything else that
// needs the same data.
//
// Why this module exists: query keys live in one place, so a prefetch fired
// on tap and the Room screen's own query use the EXACT same key — TanStack
// Query then dedupes them into a single in-flight request and the screen
// paints from cache instead of showing a spinner.

import { supabase } from './supabase';
import type { Box, Room } from '@/types/database';


/** Box with a live item count for the list subtitle. */
export type BoxWithCount = Box & { item_count: number };

/**
 * How long room/box data is considered fresh.
 *
 * These lists are kept live by realtime channels (boxes + items change
 * events invalidate them), so freshness does NOT depend on refetching on
 * every mount — this window simply prevents redundant network round trips
 * when navigating back and forth between screens.
 */
export const ROOM_STALE_MS = 5 * 60 * 1000;

export async function fetchRoom(id: string): Promise<Room> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function fetchRooms(moveId: string): Promise<Room[]> {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('move_id', moveId)
    .order('name', { ascending: true });

  if (error) throw new Error(error.message);
  return data ?? [];
}

/**
 * Natural sort for box labels, so "Box 2" stays above "Box 10".
 *
 * `box_number` is TEXT, so Postgres' ORDER BY is lexicographic and puts
 * "Box 10" (and "Box 100", "Box 1000") above "Box 2". Both box lists sort
 * with this comparator after fetching, and the SQL order is only a stable
 * starting point.
 *
 * Numbered labels compare by their number; labels without digits (custom
 * names like "Fragile") sort after the numbered ones, alphabetically.
 */
export function compareBoxNumbers(a: string, b: string): number {
  const numA = firstNumberIn(a);
  const numB = firstNumberIn(b);

  if (numA !== null && numB !== null) {
    if (numA !== numB) return numA - numB;
    // Same number (e.g. "Box 2" vs "Box 2b") — fall back to the text.
    return a.localeCompare(b);
  }
  if (numA !== null) return -1;
  if (numB !== null) return 1;
  return a.localeCompare(b);
}

/** Sorts a copy of the list into natural box-number order. */
export function sortByBoxNumber<T extends { box_number: string }>(boxes: T[]): T[] {
  return [...boxes].sort((a, b) => compareBoxNumbers(a.box_number, b.box_number));
}

/** First run of digits in a label, or null when there is none. */
function firstNumberIn(label: string): number | null {
  const match = (label ?? '').match(/\d+/);
  return match ? parseInt(match[0], 10) : null;
}

export async function fetchBoxes(roomId: string): Promise<BoxWithCount[]> {
  const { data, error } = await supabase
    .from('boxes')
    .select('*')
    .eq('room_id', roomId)
    .order('box_number', { ascending: true });

  if (error) throw new Error(error.message);
  const boxes = data ?? [];
  if (boxes.length === 0) return [];

  // Tally items per box so the subtitle under each box name stays current.
  const boxIds = boxes.map((b) => b.id);
  const { data: itemRows, error: itemError } = await supabase
    .from('items')
    .select('box_id')
    .in('box_id', boxIds);
  if (itemError) throw new Error(itemError.message);

  const counts = new Map<string, number>();
  for (const row of itemRows ?? []) {
    counts.set(row.box_id, (counts.get(row.box_id) ?? 0) + 1);
  }
  return sortByBoxNumber(boxes.map((b) => ({ ...b, item_count: counts.get(b.id) ?? 0 })));
}
