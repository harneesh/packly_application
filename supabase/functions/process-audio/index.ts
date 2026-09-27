/**
 * Packly — Process Audio Edge Function
 *
 * Purpose:
 *   Receives a temporary audio recording from the mobile app,
 *   sends it to Gemini 3.1 Flash-Lite for item extraction, and
 *   returns the extracted item names.
 *
 * Architecture:
 *   Mobile App → (audio upload) → Edge Function → Gemini 3.1 Flash-Lite → (items) → Edge Function → Mobile App
 *
 * Security:
 *   - Gemini API key is stored as an Edge Function secret (GEMINI_API_KEY)
 *   - Never exposed to mobile clients
 *   - Every request authenticated via Supabase JWT
 *
 * Response format (success):
 *   { "success": true, "items": ["Item 1", "Item 2"], "creditsRemaining": 4 }
 *
 * Response format (failure):
 *   { "success": false, "error": "Description of the error", "code": "OUT_OF_CREDITS" }
 *
 * Credit system:
 *   1 credit = 1 successful recording. The credit is consumed (idempotently,
 *   via operation_id) BEFORE the Gemini call and refunded (idempotently) if
 *   Gemini fails, so users never pay for a failed recording.
 */

import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.7'

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
// Injected automatically into every Edge Function by Supabase. Used for the
// credit RPCs, which are locked down to the service role so clients can
// never move credits directly.
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

/**
 * Estimate the decoded byte size of a base64 string.
 * ≈ base64_length × 0.75 (each base64 char encodes 6 bits = 3/4 byte)
 */
function decodedBase64Size(b64: string): number {
  return Math.ceil(b64.length * 0.75)
}

/** Build a consistent JSON response */
function jsonResponse(
  body: Record<string, unknown>,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Gemini endpoint (model name verified against the Gemini API docs).
const GEMINI_MODEL_URL =
  'https://generativelanguage.googleapis.com/v1/models/gemini-3.1-flash-lite:generateContent'

// Google-side transient failures (429 rate limit / 503 overloaded) are
// retried INSIDE the request with short backoffs, so a temporary demand
// spike usually never reaches the user as an error. Bounded total wait
// ≈ 2.4s on top of the request time — never hangs the caller.
const GEMINI_RETRY_DELAYS_MS = [800, 1600]

/**
 * Call Gemini with automatic retries for transient (429/503) failures.
 * Any other status (400/401/403/500...) fails fast — retrying can't help.
 */
async function callGemini(body: string): Promise<Response> {
  let response: Response
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`${GEMINI_MODEL_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (response.ok) return response

    const retryable = response.status === 429 || response.status === 503
    if (!retryable || attempt >= GEMINI_RETRY_DELAYS_MS.length) return response

    console.warn(
      `Gemini returned ${response.status} (attempt ${attempt + 1}) — retrying in ${GEMINI_RETRY_DELAYS_MS[attempt]}ms`,
    )
    await new Promise((resolve) => setTimeout(resolve, GEMINI_RETRY_DELAYS_MS[attempt]))
  }
}

// ──────────────────────────────────────────
// Request handler
// ──────────────────────────────────────────

serve(async (req: Request) => {
  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'authorization, x-client-info, apikey, content-type',
  }

  // ── CORS preflight ──
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // ── Method check ──
  if (req.method !== 'POST') {
    return jsonResponse(
      { success: false, error: 'Method not allowed.' },
      405,
      corsHeaders,
    )
  }

  // ── Authentication (explicit JWT verification) ──
  //
  // We verify the JWT ourselves using Supabase Auth rather than
  // relying solely on the Supabase gateway. This guarantees that
  // only authenticated users can consume Gemini quota.
  //
  const authHeader = req.headers.get('Authorization')
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return jsonResponse(
      { success: false, error: 'Unauthorized.' },
      401,
      corsHeaders,
    )
  }

  const token = authHeader.replace('Bearer ', '')

  // Create a Supabase client just for JWT verification
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    console.error('JWT verification failed:', authError?.message)
    return jsonResponse(
      { success: false, error: 'Unauthorized.' },
      401,
      corsHeaders,
    )
  }

  // User is authenticated. Proceed.
  // console.log('Authenticated user:', user.id)

  // ── Gemini API key check ──
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not configured.')
    return jsonResponse(
      { success: false, error: 'AI service not configured.' },
      500,
      corsHeaders,
    )
  }

  // ── Parse JSON body ──
  // The mobile app now sends audio as base64 in JSON to avoid
  // React Native FormData compatibility issues.
  let body: { audio?: string; mimeType?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(
      { success: false, error: 'Invalid request. Expected JSON body.' },
      400,
      corsHeaders,
    )
  }

  const base64Audio = body.audio
  const mimeType = body.mimeType || 'audio/m4a'

  if (!base64Audio || typeof base64Audio !== 'string') {
    return jsonResponse(
      { success: false, error: 'No audio data provided. Expected a JSON field "audio" with a base64 string.' },
      400,
      corsHeaders,
    )
  }

  // Reject empty audio
  if (base64Audio.length === 0) {
    return jsonResponse(
      { success: false, error: 'No speech detected. Please try again.' },
      400,
      corsHeaders,
    )
  }

  // Size limit: decoded audio must be ≤ 7.5 MB raw
  // (base64 overhead ≈ 33%, so decoded limit ≈ 10 MB after encoding)
  const decodedSize = decodedBase64Size(base64Audio)
  if (decodedSize > 7.5 * 1024 * 1024) {
    return jsonResponse(
      { success: false, error: 'Recording is too long. Please record a shorter one.' },
      400,
      corsHeaders,
    )
  }

  // ── Credit check (server-authoritative) ──
  //
  // Runs AFTER cheap validations (auth, body, size) and BEFORE the Gemini
  // call, so malformed requests never burn a credit. The RPC is idempotent
  // per operation_id: a retried request can never double-charge.
  //
  // Uses the service-role client because consume/refund are locked to the
  // service role — clients cannot call them.
  if (!SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not configured.')
    return jsonResponse(
      { success: false, error: 'AI service not configured.' },
      500,
      corsHeaders,
    )
  }

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
  const operationId = crypto.randomUUID()

  const { data: creditsRemaining, error: consumeError } = await serviceClient.rpc(
    'consume_voice_credit',
    { p_user_id: user.id, p_operation_id: operationId },
  )

  if (consumeError) {
    if (consumeError.message.includes('OUT_OF_CREDITS')) {
      return jsonResponse(
        {
          success: false,
          error: 'You are out of AI credits.',
          code: 'OUT_OF_CREDITS',
        },
        402,
        corsHeaders,
      )
    }
    console.error('consume_voice_credit failed:', consumeError.message)
    return jsonResponse(
      { success: false, error: 'Unable to start the recording. Please try again.' },
      500,
      corsHeaders,
    )
  }

  // ── Call Gemini 3.1 Flash-Lite (with transient-failure retries) ──
  try {
    const geminiResponse = await callGemini(
      JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: {
                    mimeType,
                    data: base64Audio,
                  },
                },
                {
                  text: [
                    'You are an inventory extraction assistant.',
                    'The user is packing items into a moving box.',
                    'Listen to the audio and extract only the physical item names they mention.',
                    '',
                    'Return a JSON array of strings.',
                    'Example: ["Coffee Maker", "Router", "HDMI Cable"]',
                    '',
                    'Rules:',
                    '- Include ONLY physical items (not filler words like "um", "like", "I\'m putting")',
                    '- Use proper capitalization',
                    '- Deduplicate identical items',
                    '- If no items are detected, return an empty array []',
                    '- Return ONLY the JSON array with no other text or explanation',
                  ].join('\n'),
                },
              ],
            },
          ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1024,
        },
      }),
    )

    // ── Handle Gemini API errors ──
    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text()
      console.error(
        `Gemini API error (${geminiResponse.status}):`,
        errorText.slice(0, 500),
      )
      // Refund the credit — users never pay for a failed recording.
      // Idempotent per operation_id, safe if the function retries.
      await serviceClient.rpc('refund_voice_credit', {
        p_user_id: user.id,
        p_operation_id: operationId,
      })

      // Google is rate-limiting or overloaded and the in-request retries
      // didn't clear it. Say exactly that — and reassure that no credit
      // was used — instead of a vague "unable to process" message.
      if (geminiResponse.status === 429 || geminiResponse.status === 503) {
        return jsonResponse(
          {
            success: false,
            error:
              'The AI service is busy right now. You were not charged a credit — please try again in a minute.',
            code: 'AI_OVERLOADED',
          },
          503,
          corsHeaders,
        )
      }

      return jsonResponse(
        { success: false, error: 'Unable to process audio.' },
        502,
        corsHeaders,
      )
    }

    const geminiData = await geminiResponse.json()

    // ── Extract text from Gemini response ──
    const responseText =
      geminiData?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'

    // ── Parse JSON array from response ──
    let items: string[] = []
    try {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (Array.isArray(parsed)) {
          items = parsed.filter(
            (item): item is string =>
              typeof item === 'string' && item.trim().length > 0,
          )
        }
      }
    } catch {
      // If JSON parsing fails, return empty array
      items = []
    }

    return jsonResponse(
      { success: true, items, creditsRemaining },
      200,
      corsHeaders,
    )
  } catch (err) {
    console.error('Error processing audio:', err)
    // Refund the credit — users never pay for a failed recording.
    await serviceClient.rpc('refund_voice_credit', {
      p_user_id: user.id,
      p_operation_id: operationId,
    })
    return jsonResponse(
      { success: false, error: 'Unable to process audio. Please try again.' },
      500,
      corsHeaders,
    )
  }
})
