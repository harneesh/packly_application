// services/members.ts
// Move member data access, shared by the Move screen's members sheet and the
// search filter's "Packed by" picker.
//
// Why this module exists: both surfaces use the SAME query key
// (['members', moveId]), so a list loaded by one is instantly available to
// the other without a second request.

import { supabase } from './supabase';

export interface MemberInfo {
  user_id: string;
  name: string;
  email: string;
}

/** How long the member list is considered fresh — memberships change rarely. */
export const MEMBERS_STALE_MS = 5 * 60 * 1000;

export async function fetchMembers(moveId: string): Promise<MemberInfo[]> {
  const { data, error } = await supabase.rpc('get_move_members', {
    move_id: moveId,
  });

  if (error) throw new Error(error.message);

  return (data ?? []) as MemberInfo[];
}

// ──────────────────────────────────────────
// Join requests (owner only)
// ──────────────────────────────────────────

/** Someone asking to join a move, waiting for the owner's yes or no. */
export interface JoinRequestInfo {
  user_id: string;
  name: string;
  email: string;
  requested_at: string;
}

/**
 * The pending join requests for a move, newest first.
 *
 * Returns an empty list for anyone who is not the owner, so this can be called
 * unconditionally — the server never leaks a non-owner that the list exists.
 */
export async function fetchJoinRequests(
  moveId: string,
): Promise<JoinRequestInfo[]> {
  const { data, error } = await supabase.rpc('get_move_join_requests', {
    p_move_id: moveId,
  });

  if (error) throw new Error(error.message);

  return (data ?? []) as JoinRequestInfo[];
}

/** Owner-only: let the requester in. Their request row is consumed. */
export async function approveJoinRequest(
  moveId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc('approve_move_join', {
    p_move_id: moveId,
    p_user_id: userId,
  });

  if (error) throw new Error(error.message);
}

/** Owner-only: turn the request down without adding the person. */
export async function denyJoinRequest(
  moveId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc('deny_move_join', {
    p_move_id: moveId,
    p_user_id: userId,
  });

  if (error) throw new Error(error.message);
}

/**
 * Owner-only: drop a member from the move. Removes ACCESS, never data —
 * everything they packed stays in the move (and stays attributed to them).
 */
export async function removeMoveMember(
  moveId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase.rpc('remove_move_member', {
    p_move_id: moveId,
    p_user_id: userId,
  });

  if (error) throw new Error(error.message);
}

/** Owner-only: replace the invite code, invalidating a leaked one. */
export async function rotateInviteCode(moveId: string): Promise<string> {
  const { data, error } = await supabase.rpc('rotate_invite_code', {
    p_move_id: moveId,
  });

  if (error) throw new Error(error.message);

  return String(data ?? '');
}
