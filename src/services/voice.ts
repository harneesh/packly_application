/**
 * Packly — Voice Processing Service
 *
 * Handles uploading recorded audio to the Supabase Edge Function
 * and returning extracted item names from Gemini 3.1 Flash-Lite.
 *
 * The Edge Function is the AI gateway — this service never
 * communicates with Gemini directly.
 */

import { supabase } from './supabase';
import * as FileSystem from 'expo-file-system/legacy';

/** Derive the Edge Function URL from the Supabase project URL */
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const EDGE_FUNCTION_URL = SUPABASE_URL
  ? `${SUPABASE_URL}/functions/v1/process-audio`
  : '';

export interface ProcessAudioResult {
  success: true;
  items: string[];
  /** Credits left after this recording, when the server reports it. */
  creditsRemaining?: number;
}

export interface ProcessAudioError {
  success: false;
  error: string;
  /** Machine-readable error code from the Edge Function, e.g. OUT_OF_CREDITS. */
  code?: string;
}

export type ProcessAudioResponse = ProcessAudioResult | ProcessAudioError;

/**
 * Upload a recorded audio file to the Edge Function for AI processing.
 *
 * Steps:
 *   1. Reads the temp .m4a file as base64
 *   2. Sends it as JSON to the Edge Function with JWT auth
 *   3. Edge Function calls Gemini, returns extracted items
 *   4. Deletes the temporary local audio file
 *
 * @param audioUri - The local file URI of the recorded audio (.m4a)
 * @returns The extracted item names on success, or an error object
 */
export async function processAudio(
  audioUri: string,
): Promise<ProcessAudioResponse> {
  if (!EDGE_FUNCTION_URL) {
    console.error('Missing EXPO_PUBLIC_SUPABASE_URL environment variable.');
    return {
      success: false,
      error: 'Voice processing is not configured.',
    };
  }

  // ── Get the user's current session for authentication ──
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError || !session?.access_token) {
    return {
      success: false,
      error: 'You must be signed in to use voice processing.',
    };
  }

  // ── Read audio file as base64 ──
  let base64Audio: string;
  try {
    base64Audio = await FileSystem.readAsStringAsync(audioUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
  } catch (err) {
    console.error('Failed to read audio file:', err);
    return {
      success: false,
      error: 'Failed to read the recording.',
    };
  }

  // Delete the temp file immediately after reading
  try {
    await FileSystem.deleteAsync(audioUri, { idempotent: true });
  } catch {
    // Non-critical — temp file is in cache, OS will clean it
  }

  // ── Send as JSON to Edge Function ──
  try {
    const response = await fetch(EDGE_FUNCTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio: base64Audio,
        mimeType: 'audio/m4a',
      }),
    });

    const result = (await response.json()) as ProcessAudioResponse;

    if (!response.ok) {
      // Full server response — the UI only shows a generic message, so this
      // is the only place the real server-side reason becomes visible.
      console.error(
        '[voice] Edge Function error:',
        response.status,
        JSON.stringify(result).slice(0, 300),
      );
      const errResult = result as ProcessAudioError;
      const errorMsg =
        'error' in errResult && typeof errResult.error === 'string'
          ? errResult.error
          : 'Unable to process audio. Please try again.';
      return {
        success: false,
        error: errResult.code === 'OUT_OF_CREDITS'
          ? 'You are out of AI credits.'
          : errorMsg,
        code: errResult.code,
      };
    }

    return result;
  } catch (err) {
    console.error('Error uploading audio:', err);
    return {
      success: false,
      error: 'Unable to reach the server. Please check your connection.',
    };
  }
}
