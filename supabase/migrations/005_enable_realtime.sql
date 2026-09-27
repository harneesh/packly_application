-- Packly Database Migration
-- Version: MVP 1.0
-- Description: Enables Realtime subscriptions on the core data tables so that
-- changes made by one move member are instantly reflected on other members'
-- devices without requiring a manual refresh.
--
-- Supabase Realtime uses PostgreSQL replication slots. Adding tables to the
-- supabase_realtime publication tells the system to listen for INSERT, UPDATE,
-- and DELETE events on those tables and broadcast them to subscribed clients.
--
-- Tables added:
--   rooms   — so when a member adds/renames/deletes a room, everyone sees it
--   boxes   — so when a member adds/renames/deletes a box, everyone sees it
--   items   — so when a member adds/renames/deletes an item, everyone sees it
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE boxes;
ALTER PUBLICATION supabase_realtime ADD TABLE items;
