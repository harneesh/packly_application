// components/roomEmoji.ts
// Resolves the emoji badge shown for a room — on the room chips (mockup §1),
// in the Manage Rooms sheet (mockup §3) and on the Move screen's room list.
//
// A room can carry a hand-picked emoji (rooms.emoji, chosen in the Manage
// Rooms sheet, migration 020); that always wins. Rooms without one fall back
// to keyword matching, so user-named rooms ("Master Bedroom", "Guest Bath")
// still get a fitting emoji; anything unmatched gets the house.

const RULES: [RegExp, string][] = [
  [/(bath|shower|wc|toilet|ensuite)/, '🛁'],
  [/(bed|master|guest room|bedroom)/, '🛏️'],
  [/(kitchen|cook|pantry)/, '🍳'],
  [/(din)/, '🍽️'],
  [/(liv|lounge|tv room|sitting)/, '🛋️'],
  [/(garage|car|driveway)/, '🚗'],
  [/(office|study|desk|work)/, '💻'],
  [/(laundry|wash)/, '🧺'],
  [/(garden|yard|patio|balcony|terrace)/, '🌿'],
  [/(kid|child|nursery|baby|play)/, '🧸'],
  [/(closet|storage|store|utility|attic|basement)/, '📦'],
];

/**
 * Icons offered by the room-icon picker in the Manage Rooms sheet.
 * Deliberately the SAME set the keyword rules below resolve to (plus the 🏠
 * fallback), so a hand-picked icon can never look out of place next to a
 * derived one.
 */
export const ROOM_EMOJI_OPTIONS: string[] = [
  '🏠',
  '🛏️',
  '🛋️',
  '🍳',
  '🍽️',
  '🛁',
  '💻',
  '🧺',
  '📦',
  '🚗',
  '🌿',
  '🧸',
];

/**
 * A room's emoji: the hand-picked one when set, otherwise guessed from the
 * name. Pass `room.emoji` as the second argument wherever a room is rendered.
 */
export function roomEmoji(name: string, emoji?: string | null): string {
  const picked = (emoji ?? '').trim();
  if (picked) return picked;

  const n = (name ?? '').toLowerCase();
  for (const [pattern, value] of RULES) {
    if (pattern.test(n)) return value;
  }
  return '🏠';
}
