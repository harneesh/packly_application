/**
 * Minimal WebCrypto shim for React Native (Hermes).
 *
 * supabase-js only uses the PKCE S256 code challenge when ALL of these exist:
 * `crypto`, `crypto.subtle`, and `TextEncoder`. Hermes provides none of them
 * (and no `btoa` either), so supabase-js silently falls back to the weaker
 * `plain` method and logs this warning on every sign-in:
 *
 *   WARN WebCrypto API is not supported. Code challenge method will default
 *        to use plain instead of sha256.
 *
 * This module installs only the missing pieces, backed by the already-installed
 * `expo-crypto` native module — no new packages and no rebuild required:
 *
 *   - crypto.getRandomValues  → expo-crypto getRandomValues (sync, native)
 *   - crypto.subtle.digest    → expo-crypto digest (SHA-256 etc., native)
 *   - TextEncoder             → tiny UTF-8 polyfill (only if missing)
 *   - btoa                    → tiny base64 polyfill (only if missing)
 *
 * Import this module once, before the Supabase client is created (see
 * src/services/supabase.ts).
 */
import * as Crypto from 'expo-crypto';

const g = globalThis as unknown as {
  TextEncoder?: { new (): { encode(input: string): Uint8Array } };
  btoa?: (input: string) => string;
  crypto?: {
    getRandomValues?: (array: ArrayBufferView) => unknown;
    subtle?: {
      digest(
        algorithm: string | { name: string },
        data: BufferSource
      ): Promise<ArrayBuffer>;
    };
  };
};

// --- TextEncoder -----------------------------------------------------------
// Hermes does not provide one; supabase-js needs it to encode the verifier.
if (!g.TextEncoder) {
  g.TextEncoder = class {
    encode(input: string): Uint8Array {
      const bytes = new Uint8Array(input.length * 3);
      let out = 0;
      for (let i = 0; i < input.length; i++) {
        const c = input.codePointAt(i) ?? 0;
        if (c > 0xffff) i++; // astral pair — skip the low surrogate
        if (c < 0x80) {
          bytes[out++] = c;
        } else if (c < 0x800) {
          bytes[out++] = 0xc0 | (c >> 6);
          bytes[out++] = 0x80 | (c & 0x3f);
        } else if (c < 0x10000) {
          bytes[out++] = 0xe0 | (c >> 12);
          bytes[out++] = 0x80 | ((c >> 6) & 0x3f);
          bytes[out++] = 0x80 | (c & 0x3f);
        } else {
          bytes[out++] = 0xf0 | (c >> 18);
          bytes[out++] = 0x80 | ((c >> 12) & 0x3f);
          bytes[out++] = 0x80 | ((c >> 6) & 0x3f);
          bytes[out++] = 0x80 | (c & 0x3f);
        }
      }
      return bytes.slice(0, out);
    }
  };
}

// --- btoa ------------------------------------------------------------------
// Hermes does not provide one; supabase-js needs it to base64url-encode the
// SHA-256 digest into the code challenge.
if (!g.btoa) {
  const TABLE =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  g.btoa = (input: string): string => {
    let output = '';
    for (let i = 0; i < input.length; i += 3) {
      const b0 = input.charCodeAt(i);
      const b1 = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
      const b2 = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
      output += TABLE[b0 >> 2];
      output += TABLE[((b0 & 3) << 4) | (Number.isNaN(b1) ? 0 : b1 >> 4)];
      output +=
        Number.isNaN(b1) ? '=' : TABLE[((b1 & 15) << 2) | (Number.isNaN(b2) ? 0 : b2 >> 6)];
      output += Number.isNaN(b2) ? '=' : TABLE[b2 & 63];
    }
    return output;
  };
}

// --- crypto / crypto.subtle ------------------------------------------------
// Backed by the installed expo-crypto native module.
if (!g.crypto) {
  g.crypto = {};
}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = (array) => {
    Crypto.getRandomValues(array as unknown as Parameters<typeof Crypto.getRandomValues>[0]);
    return array;
  };
}
if (!g.crypto.subtle) {
  g.crypto.subtle = {
    async digest(algorithm, data) {
      const name = (
        typeof algorithm === 'string' ? algorithm : algorithm.name ?? ''
      ).toUpperCase() as Crypto.CryptoDigestAlgorithm;
      return Crypto.digest(name, data);
    },
  };
}
