# Packly — AI Moving Inventory

Packly is a React Native (Expo) app that turns packing chaos into a searchable,
photo-documented inventory. Speak or type what's inside each box — AI transcribes
and itemizes it — and find anything later with instant search across moves,
rooms, boxes, and items.

Built for **Shipaton 2026 — Next Gen Award**.

## Run it (for judges)

The backend (Supabase: schema, RLS, Edge Functions) is already deployed and
live — you don't need your own Supabase or Gemini account. The keys below are
all meant to be public: the Supabase key is a `publishable` key with no access
beyond what row-level security allows, and the RevenueCat key is a **Test
Store** key (`test_...`) — purchases are simulated, no card or Play account
needed. The Gemini key itself is never public — it lives only as a secret on
the deployed `process-audio` Edge Function and never reaches the client or
this repo.

> This app uses native modules (RevenueCat, Reanimated, …), so it will **not**
> run inside Expo Go. Use a dev build as shown below, or install the APK.

### Option A — Install the APK (fastest)

1. Download `app-release.apk` from this repo's [Releases](../../releases) page.
2. Install it on an Android device or emulator (enable "install from unknown
   sources" if prompted). An internet connection is required.
3. Sign up with any email/password, or use Google sign-in.
4. Create a move, add a room/box, and pack it with your voice or a photo.
5. To test the paywall: open **Settings**, tap **Upgrade to Pro**, and choose
   **"Test valid purchase"** in the RevenueCat Test Store sheet. The app flips
   to Pro within a few seconds — the webhook round-trips through the live
   Supabase backend.

   **About the build:** RevenueCat's SDK only accepts a Test Store key in an
   APK marked `debuggable`, so the release APK is built with that flag set
   by [`plugins/with-debuggable-release.js`](plugins/with-debuggable-release.js).
   This is for judging only — a real Play Store release would drop that
   plugin and use a real keystore and a production RevenueCat key.

   **Why this counts as a real purchase test, not just UI theater:** Test
   Store is RevenueCat's own sanctioned mode for demoing a paywall without a
   Play Store listing or a real card. Tapping "Test valid purchase" fires an
   actual sandbox webhook from RevenueCat to this project's
   `revenuecat-webhook` Edge Function — the same secret-verified code path a
   production purchase would hit — which writes the Pro grant into
   `user_entitlements` in Postgres. The UI only reflects that row (see
   "Server-authoritative gating" below); it never unlocks Pro by itself. So
   seeing credits jump to 200 and photo uploads unlock after the test
   purchase is evidence the full RevenueCat → webhook → database pipeline
   ran, not just that a client-side flag flipped.

### Option B — Build from source

Prerequisites: Node 20+, Android Studio with an SDK (API 26+) and an
emulator, or a device with USB debugging on.

```bash
git clone <this repo>
cd packly
npm install
```

Create `.env` in the project root:

```
EXPO_PUBLIC_SUPABASE_URL=https://nguiwhzmkjkedbgzwiey.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ZVWwSwloutpbuT5PDvGJtg_8zUcPTJt
EXPO_PUBLIC_REVENUECAT_API_KEY=test_eLklryVjFTLZwUOQVDhTIojvaWo
```

```bash
npx expo run:android   # builds a dev client, installs it, and launches it
```

Then follow steps 3–5 from Option A above.

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
src/hooks/      Shared hooks (upgrade flow, entitlements, move plan)
src/services/   Supabase, auth, photos, voice, credits, entitlements
src/store/      Zustand stores (auth session, active move)
packly-ui/      Shared UI kit (theme + primitive components)
plugins/        Expo config plugins (native build settings)
supabase/
  migrations/   Versioned SQL schema + RLS policies
  functions/    Edge Functions (process-audio, revenuecat-webhook)
```

## Development setup

Same `.env` as above (see "Run it" for the values). Native modules mean
Expo Go won't work — use a dev client:

```bash
npm install
npx expo run:android   # or: npx expo start --dev-client, once a dev client is installed
```

Server secrets (Supabase Edge Function secrets, never in the repo, never
needed to run the client): `GEMINI_API_KEY`, `REVENUECAT_WEBHOOK_SECRET`.

## Architecture notes

- **Server-authoritative gating:** Free/Pro plans and AI credits are enforced
  by Postgres (RLS + triggers), not the client. Webhooks from RevenueCat
  write entitlements; the UI merely reflects them.
- **Credit model:** two buckets — signup credits never expire and survive
  subscription cycles; Pro credits (200/month) expire with the billing
  period. Consumption is idempotent (operation-id) and fully ledgered.
- **Photo storage:** membership-scoped folder-based storage policies, so
  files without a database row are still reachable for cleanup — no orphans.
