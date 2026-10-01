// lib/errors.ts
// Converts common error patterns (Supabase, network, etc.) into user-friendly
// messages that never expose raw database internals.
//
// Usage:
//   import { toFriendlyError } from '@/lib/errors';
//   ...
//   } catch (err) {
//     setError(toFriendlyError(err, 'Failed to add room.'));
//   }

/**
 * Map a raw error to a human-readable message.
 *
 * @param err       The caught value (Error, string, or unknown).
 * @param fallback  A context-specific fallback when the error type is unknown.
 *                  Defaults to "Something went wrong. Please try again."
 */
export function toFriendlyError(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!err) return fallback;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : '';

  if (!message) return fallback;

  const lower = message.toLowerCase();

  // ── Duplicate / unique constraint violations ──
  if (lower.includes('duplicate key') || lower.includes('unique constraint')) {
    return 'This name already exists. Please choose a different one.';
  }

  // ── Photo limit (raised by public.enforce_box_photo_limit()) ──
  if (lower.includes('max_photos_per_box')) {
    return 'Each box can have up to 3 photos.';
  }

  // ── Photos are Pro-only (raised by enforce_box_photo_limit).
  // Also matches PHOTOS_REQUIRE_PRO_WITH_ORPHAN, which carries the same
  // meaning plus a storage-cleanup warning.
  //
  // Pro belongs to the MOVE, not the person (migration 021): any member whose
  // subscription covers this move turns photos on for everybody, so the copy
  // points at the move rather than at a personal upgrade. ──
  if (lower.includes('photos_require_pro')) {
    return 'Photos need Pro — a Pro member of this move can share their plan with everyone in it.';
  }

  // ── Move membership and owner-only actions (raised by the 021 RPCs) ──
  if (lower.includes('not_move_owner')) {
    return 'Only the move owner can do this.';
  }
  if (lower.includes('cannot_remove_owner')) {
    return 'The move owner cannot be removed from their own move.';
  }
  if (lower.includes('not_move_member') || lower.includes('not_a_member')) {
    return 'You are not a member of this move.';
  }
  if (lower.includes('not_pro')) {
    return 'You need an active Pro plan to do this.';
  }
  if (lower.includes('invalid_invite_code')) {
    return 'Invite code not found.';
  }

  // ── Join throttling (raised by request_to_join_move, migration 023) ──
  // Checked before the generic "too many" below, which would otherwise answer
  // with the sign-in rate-limit copy.
  if (lower.includes('too_many_join_attempts')) {
    return 'Too many tries. Wait a bit, then try again.';
  }

  // ── AI credits (raised by public.consume_voice_credit() / Edge Function) ──
  if (lower.includes('out_of_credits') || lower.includes('out of ai credits')) {
    return 'You are out of AI credits.';
  }

  // ── Foreign key violations ──
  if (lower.includes('foreign key') || lower.includes('violates foreign')) {
    return 'This item is linked to other data and cannot be modified.';
  }

  // ── Row Level Security / permission errors ──
  if (
    lower.includes('permission denied') ||
    lower.includes('policy') ||
    lower.includes('row-level security') ||
    lower.includes('new row violates')
  ) {
    return 'You do not have permission to perform this action.';
  }

  // ── Not found ──
  if (lower.includes('not found') || lower.includes('no rows') || lower.includes('does not exist')) {
    return 'The requested item could not be found.';
  }

  // ── Network / connection errors ──
  if (
    lower.includes('network') ||
    lower.includes('fetch') ||
    lower.includes('timeout') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('unable to connect')
  ) {
    return 'Unable to connect. Please check your internet connection and try again.';
  }

  // ── Auth errors ──
  if (lower.includes('invalid login') || lower.includes('invalid credentials')) {
    return 'Invalid email or password. Please try again.';
  }
  if (lower.includes('email not confirmed')) {
    return 'Please confirm your email address before signing in.';
  }
  if (lower.includes('user already registered')) {
    return 'An account with this email already exists.';
  }
  if (
    lower.includes('rate limit') ||
    lower.includes('too many') ||
    lower.includes('429')
  ) {
    return 'Too many attempts. Please wait a moment and try again.';
  }

  // ── Known Supabase error codes ──
  // 23505 = unique_violation, 23503 = foreign_key_violation
  if (message.includes('23505')) {
    return 'This name already exists. Please choose a different one.';
  }
  if (message.includes('23503')) {
    return 'This item is linked to other data and cannot be modified.';
  }
  if (message.includes('42P01')) {
    return 'Something went wrong with the database. Please try again.';
  }

  // ── Fallback: still hide the raw technical detail ──
  // The message might be a long SQL string or technical error. Only show it
  // if it looks like a pre-formatted friendly message (short, no SQL keywords).
  if (
    message.length > 120 ||
    lower.includes('select') ||
    lower.includes('insert') ||
    lower.includes('update') ||
    lower.includes('delete') ||
    lower.includes('from') ||
    lower.includes('where') ||
    lower.includes('null value') ||
    lower.includes('violates') ||
    lower.includes('relation') ||
    lower.includes('column') ||
    lower.includes('syntax') ||
    lower.includes('error:')
  ) {
    return fallback;
  }

  // If the message is short and doesn't look like SQL, it's probably already
  // a friendly message (e.g. from our own throw new Error('...')).
  return message;
}
