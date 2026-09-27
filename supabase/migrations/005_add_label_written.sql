-- Add label_written column to boxes table
-- Tracks whether the user has written the box number on their physical box
ALTER TABLE public.boxes
ADD COLUMN label_written BOOLEAN NOT NULL DEFAULT false;
