-- Migration 020: Room emoji icon
-- Adds an optional per-room emoji, picked by the user in the Manage Rooms
-- sheet on Home, so a room's badge is not limited to the keyword guess in
-- roomEmoji.ts ("Kitchen" → 🍳, but "HQ" or "Stuff" would fall back to 🏠).
--
-- NULL = the user never picked one → the UI keeps deriving an emoji from the
-- room name, so every existing room renders exactly as it does today.
--
-- rooms already has RLS "Members can update rooms", so no policy changes are
-- needed for this column.

ALTER TABLE public.rooms
  ADD COLUMN IF NOT EXISTS emoji TEXT;
