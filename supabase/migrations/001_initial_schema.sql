-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Creates all 6 tables for the Packly moving inventory application

-- ============================================
-- Table: users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Table: moves
-- ============================================
CREATE TABLE IF NOT EXISTS moves (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Table: move_members
-- Composite primary key on (move_id, user_id)
-- ============================================
CREATE TABLE IF NOT EXISTS move_members (
  move_id UUID NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (move_id, user_id)
);

-- ============================================
-- Table: rooms
-- ============================================
CREATE TABLE IF NOT EXISTS rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  move_id UUID NOT NULL REFERENCES moves(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);

-- ============================================
-- Table: boxes
-- Unique constraint on (room_id, box_number)
-- ============================================
CREATE TABLE IF NOT EXISTS boxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  box_number TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, box_number)
);

-- ============================================
-- Table: items
-- ============================================
CREATE TABLE IF NOT EXISTS items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  box_id UUID NOT NULL REFERENCES boxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- Indexes for performance
-- ============================================
CREATE INDEX IF NOT EXISTS idx_moves_owner_id ON moves(owner_id);
CREATE INDEX IF NOT EXISTS idx_moves_invite_code ON moves(invite_code);
CREATE INDEX IF NOT EXISTS idx_move_members_user_id ON move_members(user_id);
CREATE INDEX IF NOT EXISTS idx_rooms_move_id ON rooms(move_id);
CREATE INDEX IF NOT EXISTS idx_boxes_room_id ON boxes(room_id);
CREATE INDEX IF NOT EXISTS idx_items_box_id ON items(box_id);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

-- ============================================
-- users table
-- ============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON users FOR SELECT
  USING (id = auth.uid());

CREATE POLICY "Users can insert own profile"
  ON users FOR INSERT
  WITH CHECK (id = auth.uid());

CREATE POLICY "Users can update own profile"
  ON users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "Users can delete own profile"
  ON users FOR DELETE
  USING (id = auth.uid());

-- ============================================
-- moves table
-- ============================================
ALTER TABLE moves ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view moves"
  ON moves FOR SELECT
  USING (
    owner_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = moves.id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create moves"
  ON moves FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can update moves"
  ON moves FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "Owners can delete moves"
  ON moves FOR DELETE
  USING (owner_id = auth.uid());

-- ============================================
-- move_members table
-- ============================================
ALTER TABLE move_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view move members"
  ON move_members FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM move_members AS mm
      WHERE mm.move_id = move_members.move_id
      AND mm.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can join moves"
  ON move_members FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = move_id
      AND moves.owner_id = auth.uid()
    )
  );

CREATE POLICY "Members can leave moves"
  ON move_members FOR DELETE
  USING (user_id = auth.uid());

-- ============================================
-- rooms table
-- ============================================
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view rooms"
  ON rooms FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = rooms.move_id
      AND move_members.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = rooms.move_id
      AND moves.owner_id = auth.uid()
    )
  );

CREATE POLICY "Members can create rooms"
  ON rooms FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = rooms.move_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = rooms.move_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can update rooms"
  ON rooms FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = rooms.move_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = rooms.move_id
      AND move_members.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = rooms.move_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = rooms.move_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can delete rooms"
  ON rooms FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM moves
      WHERE moves.id = rooms.move_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM move_members
      WHERE move_members.move_id = rooms.move_id
      AND move_members.user_id = auth.uid()
    )
  );

-- ============================================
-- boxes table
-- ============================================
ALTER TABLE boxes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view boxes"
  ON boxes FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND move_members.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM rooms
      JOIN moves ON moves.id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND moves.owner_id = auth.uid()
    )
  );

CREATE POLICY "Members can create boxes"
  ON boxes FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN moves ON moves.id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM rooms
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can update boxes"
  ON boxes FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN moves ON moves.id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM rooms
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND move_members.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN moves ON moves.id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM rooms
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can delete boxes"
  ON boxes FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM rooms
      JOIN moves ON moves.id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM rooms
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE rooms.id = boxes.room_id
      AND move_members.user_id = auth.uid()
    )
  );

-- ============================================
-- items table
-- ============================================
ALTER TABLE items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view items"
  ON items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND move_members.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN moves ON moves.id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND moves.owner_id = auth.uid()
    )
  );

CREATE POLICY "Members can create items"
  ON items FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN moves ON moves.id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can update items"
  ON items FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN moves ON moves.id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND move_members.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN moves ON moves.id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND move_members.user_id = auth.uid()
    )
  );

CREATE POLICY "Members can delete items"
  ON items FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN moves ON moves.id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND moves.owner_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM boxes
      JOIN rooms ON rooms.id = boxes.room_id
      JOIN move_members ON move_members.move_id = rooms.move_id
      WHERE boxes.id = items.box_id
      AND move_members.user_id = auth.uid()
    )
  );
