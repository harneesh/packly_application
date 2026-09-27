# Packly — AI Moving Inventory

Packly is a React Native (Expo) app that turns packing chaos into a searchable,
photo-documented inventory. Speak or type what's inside each box — AI transcribes
and itemizes it — and find anything later with instant search across moves,
rooms, boxes, and items.

## Tech stack

- **App:** Expo SDK 57, React Native 0.86, TypeScript, Expo Router
- **Backend:** Supabase — Postgres with row-level security, realtime sync,
  Storage for box photos, Edge Functions
- **AI:** Gemini via a Supabase Edge Function (the client never talks to the
  model directly; audio is never persisted)
- **Subscriptions:** RevenueCat (`pro` entitlement, $5/month) with a
  server-authoritative webhook into Postgres

## Repository layout

```
src/app/        Expo Router screens (auth, tabs, move/room/box, settings)
src/components/ UI components (photo gallery, bottom sheets, modals)
src/services/   Supabase, auth, photos, voice, credits, entitlements
src/store/      Zustand stores (auth session, active move)
packly-ui/      Shared UI kit (theme + primitive components)
supabase/
  migrations/   Versioned SQL schema + RLS policies
  functions/    Edge Functions (process-audio, revenuecat-webhook)
```

## Getting started

```bash
npm install
npx expo start        # then press a (Android) with a device connected
```

Environment (`.env`, gitignored):

```
EXPO_PUBLIC_SUPABASE_URL=...
EXPO_PUBLIC_SUPABASE_ANON_KEY=...
EXPO_PUBLIC_REVENUECAT_API_KEY=...
```

Server secrets (Supabase Edge Function secrets, never in the repo):
`GEMINI_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`.

## Architecture notes

- **Server-authoritative gating:** Free/Pro plans and AI credits are enforced
  by Postgres (RLS + triggers), not the client. Webhooks from RevenueCat
  write entitlements; the UI merely reflects them.
- **Credit model:** two buckets — signup credits never expire and survive
  subscription cycles; Pro credits (200/month) expire with the billing
  period. Consumption is idempotent (operation-id) and fully ledgered.
- **Photo storage:** membership-scoped folder-based storage policies, so
  files without a database row are still reachable for cleanup — no orphans.
