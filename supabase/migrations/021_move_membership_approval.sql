-- Packly Database Migration
-- Version: 021
-- Description: Move membership approval + move-level Pro sharing.
--
-- Three changes, all serving one idea: a move's PEOPLE and a move's PLAN are
-- both explicit now.
--
-- 1) JOINING A MOVE REQUIRES THE OWNER'S APPROVAL
--    Requests wait in their own table. A requester is NOT a member: there is
--    no row for them in move_members until the owner approves, and approval
--    copies the request into move_members and deletes it. Every membership
--    check in the database — the ones already written and the ones nobody has
--    written yet — is therefore correct by construction: it cannot see a
--    requester, because there is nothing there for it to see.
--      • A requester can read the move's NAME (so the app can say which move
--        they asked to join) and their own request row, and nothing else —
--        not a single room, box, item, photo or storage object.
--      • Joining is now code-validated server-side (request_to_join_move)
--        instead of a client INSERT, so knowing a move's id is not enough to
--        get in.
--    Owner-only RPCs: approve_move_join, deny_move_join, remove_move_member,
--    rotate_invite_code. get_move_join_requests lists the queue.
--
-- 2) MEMBERSHIP PREDICATES ARE CENTRALIZED
--    Before this migration "is this user in this move" was inlined in 19 RLS
--    policies, 3 storage policies and several RPCs. Every one of them now
--    calls ONE helper, so the rule has a single home and a future change
--    (roles, removal, guests) is a one-line edit instead of a hunt:
--      is_move_member(move_id) — owner or member (auth.uid())
--      is_move_joiner(move_id) — the above, or a pending requester
--      is_box_member(box_id)   — the same, resolved box → room → move
--      is_move_owner(move_id)  — owner only (approvals, moderation)
--    Acceptance test: no policy may reference move_members directly.
--    search_user_items() (004, already superseded by search_inventory) is
--    DROPPED as dead code — and as a second copy of the membership rule, which
--    is exactly what this migration exists to stop accumulating.
--
-- 3) PRO IS SHARED WITH THE MOVE, AND SWITCHABLE PER MOVE
--    A move is Pro when ANY active member holds an active subscription, so a
--    family never buys Pro per person. Nothing is granted or stored per member:
--    the answer is DERIVED on every read, which is why joining, leaving,
--    lapsing and ownership transfer all resolve themselves with no cleanup job
--    and no drift.
--      • move_pro_payers(move_id) — the subscribers covering this move.
--      • move_is_pro(move_id)    — non-empty above; the photo gate.
--      • move_plan(move_id)      — client-facing summary, "shared by …".
--      • move_pro_switches       — a subscriber can switch sharing OFF for one
--        move. Off is symmetric: the move is Free for everyone, including the
--        subscriber, whose plan keeps working everywhere else. An ABSENT row
--        means shared, so nobody is affected until they choose.
--      • Credits: one 200/month pool per subscriber, shared with every move
--        they cover. There is no pool table — the subscriber's own pro bucket
--        IS the pool. consume_voice_credit spends it first when the recording
--        belongs to a covered move, and the ledger records BOTH the bucket
--        owner (whose balance moved) and who spent it.
--
-- This also repairs 013's owner-anchored photo gate, under which a PAYING
-- MEMBER's subscription granted their own move nothing.
--
-- Idempotent: safe to re-run.

-- ============================================
-- 1) Joining a move: requests live in their OWN table
--
-- The obvious model here is a status column on move_members ('pending' |
-- 'active'), and it is the wrong one. Membership is checked in ~19 RLS
-- policies, 3 storage policies and several SECURITY DEFINER RPCs — including
-- search_inventory, whose body inlines move_members three times. Every one of
-- those would have had to remember to filter on the new column, and a single
-- forgotten predicate is a silent leak: a requester reading the whole
-- inventory. That is a permanent tax on every future query too.
--
-- So a REQUESTER IS NOT A MEMBER AT ALL. Requests wait in their own table
-- until the owner approves, and approval copies the row into move_members and
-- deletes the request. Every membership check in the database — the ones
-- written already and the ones nobody has written yet — is therefore correct
-- by construction: it cannot see a requester, because there is nothing there
-- for it to see.
-- ============================================
CREATE TABLE IF NOT EXISTS public.move_join_requests (
  move_id      UUID NOT NULL REFERENCES public.moves(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (move_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_move_join_requests_move
  ON public.move_join_requests(move_id, requested_at DESC);

ALTER TABLE public.move_join_requests ENABLE ROW LEVEL SECURITY;

-- NOTE: this table's own SELECT policy is created at the top of section 3,
-- NOT here. It calls public.is_move_owner(), and Postgres validates a policy's
-- expression the moment the policy is created — so a helper used by a policy
-- must already exist ABOVE it in the file. Section 3 comes after the helpers.
GRANT SELECT ON public.move_join_requests TO authenticated;

-- ============================================
-- 2) Membership helpers — the single source of truth
--
-- All of these are SECURITY DEFINER so a policy never recurses into the
-- move_members policy it is trying to enforce, and all are STABLE: within one
-- statement the answer cannot change underneath the planner.
-- ============================================

-- Internal form: an explicit user id, so service-role callers (which have no
-- auth.uid(), e.g. the process-audio Edge Function) can ask the exact same
-- question the policies ask.
CREATE OR REPLACE FUNCTION public.is_move_member_for(p_move_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
     AND p_move_id IS NOT NULL
     AND (
       EXISTS (SELECT 1 FROM public.moves m
                WHERE m.id = p_move_id AND m.owner_id = p_user_id)
       OR EXISTS (SELECT 1 FROM public.move_members mm
                   WHERE mm.move_id = p_move_id
                     AND mm.user_id = p_user_id)
     );
$$;

/** Owner or active member of the move. The one predicate every policy uses. */
CREATE OR REPLACE FUNCTION public.is_move_member(p_move_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.is_move_member_for(p_move_id, auth.uid());
$$;

/**
 * Owner, member, OR pending requester. Deliberately used for ONE thing:
 * reading the move row itself, so a requester can be told which move they have
 * asked to join (name only — it grants no access to anything inside).
 */
CREATE OR REPLACE FUNCTION public.is_move_joiner(p_move_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND (
       public.is_move_member(p_move_id)
       OR EXISTS (SELECT 1 FROM public.move_join_requests jr
                   WHERE jr.move_id = p_move_id AND jr.user_id = auth.uid())
     );
$$;

CREATE OR REPLACE FUNCTION public.is_move_owner(p_move_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.moves m
                  WHERE m.id = p_move_id AND m.owner_id = auth.uid());
$$;

/** box → room → move. NULL for a box that does not exist. */
CREATE OR REPLACE FUNCTION public.move_of_box(p_box_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT r.move_id
    FROM public.boxes b
    JOIN public.rooms r ON r.id = b.room_id
   WHERE b.id = p_box_id;
$$;

/** Owner or active member of the move a box lives in. */
CREATE OR REPLACE FUNCTION public.is_box_member(p_box_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.is_move_member(public.move_of_box(p_box_id));
$$;

-- ============================================
-- 3) RLS — every policy rerouted through the helpers
--
-- Each policy below is DROPped and recreated with the same NAME it had
-- before, so nothing else in the schema has to change. Only the predicate
-- moves: one call to a helper instead of an inlined EXISTS on move_members,
-- so the membership rule lives in exactly one place from now on.
--
-- ORDERING RULE for anyone extending this file: a policy expression is
-- validated at CREATE time, so every public.* function it calls must already
-- be defined ABOVE this point. That is exactly why the new table's policy is
-- created here instead of beside its table in section 1 — it calls
-- is_move_owner(), which section 2 defines. (supabase/audit-forward-refs.js
-- checks this statically; run it before applying any edit to this file.)
-- ============================================

-- ── move_join_requests (the new table from section 1) ──
-- A requester sees their own request (so the app can say "waiting for the
-- owner"), and the move's owner sees the queue. Nobody else sees anything.
-- There are deliberately no INSERT/UPDATE/DELETE policies: request_to_join_move,
-- approve_move_join and deny_move_join are the only writers.
DROP POLICY IF EXISTS "Requesters and owners can view join requests" ON public.move_join_requests;
CREATE POLICY "Requesters and owners can view join requests"
  ON public.move_join_requests FOR SELECT
  USING (user_id = auth.uid() OR public.is_move_owner(move_id));

-- ── moves ──────────────────────────────────────────────
-- is_move_joiner (not is_move_member) so a pending requester can read the NAME
-- of the move they asked to join. It exposes the move row only — everything
-- inside requires is_move_member.
DROP POLICY IF EXISTS "Members can view moves" ON public.moves;
CREATE POLICY "Members can view moves"
  ON public.moves FOR SELECT
  USING (public.is_move_joiner(id));

-- ── move_members ───────────────────────────────────────
-- Members see the roster. A requester is not in this table at all, so there is
-- nothing here for them to read — their own request lives in
-- move_join_requests, which they can read.
DROP POLICY IF EXISTS "Members can view move members" ON public.move_members;
CREATE POLICY "Members can view move members"
  ON public.move_members FOR SELECT
  USING (public.is_move_member(move_id));

-- Self-joins no longer insert directly: request_to_join_move() does it with
-- the code validated server-side. Direct inserts are the owner adding people.
DROP POLICY IF EXISTS "Members can join moves" ON public.move_members;
CREATE POLICY "Members can join moves"
  ON public.move_members FOR INSERT
  WITH CHECK (public.is_move_owner(move_id));

DROP POLICY IF EXISTS "Members can leave moves" ON public.move_members;
CREATE POLICY "Members can leave moves"
  ON public.move_members FOR DELETE
  USING (user_id = auth.uid());

-- ── rooms ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view rooms" ON public.rooms;
CREATE POLICY "Members can view rooms"
  ON public.rooms FOR SELECT
  USING (public.is_move_member(move_id));

DROP POLICY IF EXISTS "Members can create rooms" ON public.rooms;
CREATE POLICY "Members can create rooms"
  ON public.rooms FOR INSERT
  WITH CHECK (public.is_move_member(move_id));

DROP POLICY IF EXISTS "Members can update rooms" ON public.rooms;
CREATE POLICY "Members can update rooms"
  ON public.rooms FOR UPDATE
  USING (public.is_move_member(move_id))
  WITH CHECK (public.is_move_member(move_id));

DROP POLICY IF EXISTS "Members can delete rooms" ON public.rooms;
CREATE POLICY "Members can delete rooms"
  ON public.rooms FOR DELETE
  USING (public.is_move_member(move_id));

-- ── boxes ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view boxes" ON public.boxes;
CREATE POLICY "Members can view boxes"
  ON public.boxes FOR SELECT
  USING (public.is_box_member(id));

DROP POLICY IF EXISTS "Members can create boxes" ON public.boxes;
CREATE POLICY "Members can create boxes"
  ON public.boxes FOR INSERT
  WITH CHECK (public.is_box_member(id));

DROP POLICY IF EXISTS "Members can update boxes" ON public.boxes;
CREATE POLICY "Members can update boxes"
  ON public.boxes FOR UPDATE
  USING (public.is_box_member(id))
  WITH CHECK (public.is_box_member(id));

DROP POLICY IF EXISTS "Members can delete boxes" ON public.boxes;
CREATE POLICY "Members can delete boxes"
  ON public.boxes FOR DELETE
  USING (public.is_box_member(id));

-- ── items ──────────────────────────────────────────────
DROP POLICY IF EXISTS "Members can view items" ON public.items;
CREATE POLICY "Members can view items"
  ON public.items FOR SELECT
  USING (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can create items" ON public.items;
CREATE POLICY "Members can create items"
  ON public.items FOR INSERT
  WITH CHECK (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can update items" ON public.items;
CREATE POLICY "Members can update items"
  ON public.items FOR UPDATE
  USING (public.is_box_member(box_id))
  WITH CHECK (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can delete items" ON public.items;
CREATE POLICY "Members can delete items"
  ON public.items FOR DELETE
  USING (public.is_box_member(box_id));

-- ── users (006) ────────────────────────────────────────
-- Members of a move see each other's profiles. A PENDING requester's profile is
-- visible to that move's members on purpose: the owner has to see who is asking
-- before approving them.
DROP POLICY IF EXISTS "Members can view profiles of move collaborators" ON public.users;
CREATE POLICY "Members can view profiles of move collaborators"
  ON public.users FOR SELECT
  USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.move_members mm
       WHERE mm.user_id = users.id
         AND public.is_move_member(mm.move_id)
    )
  );
-- Requesters' profiles are NOT visible through this policy (they are not
-- members). The owner still sees who is asking, because get_move_join_requests
-- is SECURITY DEFINER and joins users itself.

-- ── box_photos (009) ───────────────────────────────────
DROP POLICY IF EXISTS "Members can view box photos" ON public.box_photos;
CREATE POLICY "Members can view box photos"
  ON public.box_photos FOR SELECT
  USING (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can create box photos" ON public.box_photos;
CREATE POLICY "Members can create box photos"
  ON public.box_photos FOR INSERT
  WITH CHECK (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can update box photos" ON public.box_photos;
CREATE POLICY "Members can update box photos"
  ON public.box_photos FOR UPDATE
  USING (public.is_box_member(box_id))
  WITH CHECK (public.is_box_member(box_id));

DROP POLICY IF EXISTS "Members can delete box photos" ON public.box_photos;
CREATE POLICY "Members can delete box photos"
  ON public.box_photos FOR DELETE
  USING (public.is_box_member(box_id));

-- ── storage.objects (009) ──────────────────────────────
-- Object paths are {box_id}/{uuid}.jpg, so the top folder IS the box id and
-- the same helper answers for every storage policy. A non-uuid folder raises a
-- cast error rather than silently allowing access — the same behavior these
-- policies had before.
DROP POLICY IF EXISTS "Members can upload box photos" ON storage.objects;
CREATE POLICY "Members can upload box photos"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'box-photos'
    AND public.is_box_member((storage.foldername(storage.objects.name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Members can view box photos" ON storage.objects;
CREATE POLICY "Members can view box photos"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'box-photos'
    AND public.is_box_member((storage.foldername(storage.objects.name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Members can delete box photos" ON storage.objects;
CREATE POLICY "Members can delete box photos"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'box-photos'
    AND public.is_box_member((storage.foldername(storage.objects.name))[1]::uuid)
  );

-- ── dead code that bypassed all of the above ───────────
-- 004's search_user_items is dead code: superseded by search_inventory (016)
-- and called by nothing. It is dropped here rather than left to rot, and
-- because it is a second place where "am I in this move?" was spelled out —
-- exactly the kind of duplicate this migration exists to remove.
DROP FUNCTION IF EXISTS public.search_user_items(text, int);

-- ============================================
-- 4) Joining a move: request → approve
-- ============================================

/**
 * Join a move by invite code.
 *
 * The code is validated HERE, server-side. Before this migration the client
 * simply INSERTed into move_members with the policy "user_id = auth.uid()",
 * which meant knowing a move's id was enough to become a member of it. The
 * code is now the only way in, and it only ever produces a REQUEST.
 *
 * Returns the move (id, name) and the caller's resulting status:
 *   'active'  — the caller owns the move, or is already a member of it
 *   'pending' — a request now exists (created by this call, or already waiting)
 * Idempotent: calling it again returns the same status, never a second row.
 */
CREATE OR REPLACE FUNCTION public.request_to_join_move(p_invite_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_move_id uuid;
  v_name    text;
  v_owner   uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  SELECT m.id, m.name, m.owner_id
    INTO v_move_id, v_name, v_owner
    FROM public.moves m
   WHERE m.invite_code = NULLIF(upper(trim(COALESCE(p_invite_code, ''))), '');

  IF v_move_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_INVITE_CODE';
  END IF;

  -- Already in? Owners and members are done — asking again changes nothing.
  IF public.is_move_member_for(v_move_id, auth.uid()) THEN
    RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'active');
  END IF;

  -- ON CONFLICT DO NOTHING keeps this idempotent: a request that already exists
  -- is left alone rather than duplicated or re-dated.
  INSERT INTO public.move_join_requests (move_id, user_id)
  VALUES (v_move_id, auth.uid())
  ON CONFLICT (move_id, user_id) DO NOTHING;

  RETURN json_build_object('id', v_move_id, 'name', v_name, 'status', 'pending');
END;
$$;

/**
 * Owner-only: approve a request. The request becomes a membership and the
 * request row goes away, so "is this person in the move?" has exactly one
 * answer in exactly one place. Idempotent, and safe to click twice.
 */
CREATE OR REPLACE FUNCTION public.approve_move_join(p_move_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_owner(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_OWNER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.move_join_requests
     WHERE move_id = p_move_id AND user_id = p_user_id
  ) THEN
    -- Approving twice is a no-op; approving somebody who never asked is an error.
    PERFORM 1 FROM public.move_members
      WHERE move_id = p_move_id AND user_id = p_user_id;
    IF FOUND THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'NO_JOIN_REQUEST';
  END IF;

  INSERT INTO public.move_members (move_id, user_id)
  VALUES (p_move_id, p_user_id)
  ON CONFLICT (move_id, user_id) DO NOTHING;

  DELETE FROM public.move_join_requests
   WHERE move_id = p_move_id AND user_id = p_user_id;
END;
$$;

/** Owner-only: drop a request. The person may ask again later. */
CREATE OR REPLACE FUNCTION public.deny_move_join(p_move_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_owner(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_OWNER';
  END IF;

  DELETE FROM public.move_join_requests
   WHERE move_id = p_move_id AND user_id = p_user_id;
END;
$$;

/**
 * Owner-only: remove an active member.
 *
 * Removes ACCESS, never data: the rooms, boxes, items and photos they created
 * stay in the move (created_by is attribution, not ownership). The owner cannot
 * remove themselves — that would orphan the move.
 */
CREATE OR REPLACE FUNCTION public.remove_move_member(p_move_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_owner(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_OWNER';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'CANNOT_REMOVE_OWNER';
  END IF;

  DELETE FROM public.move_members
   WHERE move_id = p_move_id
     AND user_id = p_user_id
     AND user_id <> auth.uid();
END;
$$;

/** 6 uppercase alphanumeric characters — same shape the app generates. */
CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS text
LANGUAGE sql
VOLATILE
AS $$
  SELECT string_agg(
           substr('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
                  1 + floor(random() * 36)::int,
                  1),
           ''
         )
    FROM generate_series(1, 6);
$$;

/** Owner-only: replace the invite code, invalidating one that leaked. */
CREATE OR REPLACE FUNCTION public.rotate_invite_code(p_move_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_code text;
  v_try  int := 0;
BEGIN
  IF NOT public.is_move_owner(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_OWNER';
  END IF;

  LOOP
    v_try  := v_try + 1;
    v_code := public.generate_invite_code();
    BEGIN
      UPDATE public.moves SET invite_code = v_code WHERE id = p_move_id;
      RETURN v_code;
    EXCEPTION WHEN unique_violation THEN
      -- 6-character collision with another move: try again.
      IF v_try >= 5 THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END;
$$;

/**
 * Owner-only: the pending requests for a move, newest first. Returns nothing
 * for anyone who is not the owner (a non-owner sees an empty list rather than
 * an error, so the client can call it unconditionally). SECURITY DEFINER, so
 * the owner sees the requester's name and email even though the users policy
 * does not expose non-members.
 */
CREATE OR REPLACE FUNCTION public.get_move_join_requests(p_move_id uuid)
RETURNS TABLE (user_id uuid, name text, email text, requested_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_owner(p_move_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT jr.user_id, u.name, u.email, jr.requested_at
    FROM public.move_join_requests jr
    JOIN public.users u ON u.id = jr.user_id
   WHERE jr.move_id = p_move_id
   ORDER BY jr.requested_at DESC;
END;
$$;

/**
 * get_move_members (007) — same shape, but the membership test now goes through
 * the shared helper, and it is being re-created here so the security check
 * lives in one place. Behavior is otherwise unchanged.
 */
CREATE OR REPLACE FUNCTION public.get_move_members(move_id UUID)
RETURNS TABLE (
  user_id UUID,
  name TEXT,
  email TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_member(get_move_members.move_id) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    u.name,
    u.email
  FROM public.move_members mm
  JOIN public.users u ON u.id = mm.user_id
  WHERE mm.move_id = get_move_members.move_id;
END;
$$;

-- ============================================
-- 5) Pro — derived per move, switchable per move
-- ============================================

-- ── The per-move sharing switch (the table comes FIRST) ──
-- move_pro_payers below is LANGUAGE sql, and Postgres validates an SQL body at
-- CREATE time — including the objects it reads — so this table has to exist
-- before that function is created, not merely before it is called.
--
-- An ABSENT row means shared, so nothing changes for anyone until they touch
-- it, and there is no backfill to get wrong.
CREATE TABLE IF NOT EXISTS public.move_pro_switches (
  move_id    UUID NOT NULL REFERENCES public.moves(id) ON DELETE CASCADE,
  payer_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (move_id, payer_id)
);

ALTER TABLE public.move_pro_switches ENABLE ROW LEVEL SECURITY;

/**
 * The subscribers covering this move: a live Pro period, held by the owner or
 * an ACTIVE member, minus anyone who switched sharing off for this move.
 *
 * Ordered deterministically — longest-running period first, then user id — so
 * the "primary" payer (display, and whose credits are spent first) never
 * flickers between two reads of the same data.
 */
CREATE OR REPLACE FUNCTION public.move_pro_payers(p_move_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(
           array_agg(e.user_id ORDER BY e.period_end DESC NULLS LAST, e.user_id),
           '{}'::uuid[]
         )
    FROM public.user_entitlements e
   WHERE e.plan = 'pro'
     AND e.period_end > now()
     AND public.is_move_member_for(p_move_id, e.user_id)
     AND COALESCE(
           (SELECT sw.enabled
              FROM public.move_pro_switches sw
             WHERE sw.move_id = p_move_id
               AND sw.payer_id = e.user_id),
           true
         );
$$;

/** Pro is active in this move. Derived on every read — nothing to clean up. */
CREATE OR REPLACE FUNCTION public.move_is_pro(p_move_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT array_length(public.move_pro_payers(p_move_id), 1) IS NOT NULL;
$$;

-- ── The switch table's own policy ─────────
-- (The table itself is created at the top of section 5, before the SQL
-- function that reads it — see the note there.)
--
-- Members can read their own move's switches (it is not sensitive information,
-- and it is what lets Realtime push "sharing turned off" to every device).
-- There are deliberately NO insert/update/delete policies: set_move_pro_enabled
-- below is the only writer, so a client cannot fake another user's row.
DROP POLICY IF EXISTS "Members can view move pro switches" ON public.move_pro_switches;
CREATE POLICY "Members can view move pro switches"
  ON public.move_pro_switches FOR SELECT
  USING (public.is_move_member(move_id));

GRANT SELECT ON public.move_pro_switches TO authenticated;

-- Realtime for the two transitions members care about: their request being
-- approved, and the move's Pro being switched on/off.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'move_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.move_members;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'move_pro_switches'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.move_pro_switches;
  END IF;
END $$;

/**
 * Switch Pro sharing for ONE move.
 *
 * The caller must be a live Pro subscriber AND the owner or an active member of
 * the move — you cannot enable your plan on a move you are not in.
 *
 * Off is symmetric: the move is Free for everyone in it, including the caller,
 * and their credits are no longer spendable there. Their subscription keeps
 * working in their other moves.
 */
CREATE OR REPLACE FUNCTION public.set_move_pro_enabled(p_move_id uuid, p_enabled boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED';
  END IF;

  IF NOT public.is_move_member(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_MEMBER';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_entitlements e
     WHERE e.user_id = auth.uid()
       AND e.plan = 'pro'
       AND e.period_end > now()
  ) THEN
    RAISE EXCEPTION 'NOT_PRO';
  END IF;

  INSERT INTO public.move_pro_switches (move_id, payer_id, enabled)
  VALUES (p_move_id, auth.uid(), p_enabled)
  ON CONFLICT (move_id, payer_id) DO UPDATE
    SET enabled    = EXCLUDED.enabled,
        updated_at = now();
END;
$$;

/**
 * Client-facing Pro summary for one move.
 *
 * Raises for a non-member: you may only ask about a move you belong to.
 * payer_names is display names only — RLS keeps every user_entitlements row
 * private to its owner, and this function never returns anyone's plan but the
 * aggregate's.
 */
CREATE OR REPLACE FUNCTION public.move_plan(p_move_id uuid)
RETURNS TABLE (
  plan        text,
  period_end  timestamptz,
  payer_id    uuid,
  payer_names text[],
  is_payer    boolean,
  sharing_on  boolean,
  can_toggle  boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_payers uuid[];
BEGIN
  IF NOT public.is_move_member(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_MEMBER';
  END IF;

  v_payers := public.move_pro_payers(p_move_id);

  RETURN QUERY
  SELECT
    CASE WHEN array_length(v_payers, 1) IS NOT NULL THEN 'pro' ELSE 'free' END,
    (SELECT max(e.period_end) FROM public.user_entitlements e
      WHERE e.user_id = ANY(v_payers) AND e.plan = 'pro'),
    (SELECT e.user_id FROM public.user_entitlements e
      WHERE e.user_id = ANY(v_payers) AND e.plan = 'pro'
      ORDER BY e.period_end DESC NULLS LAST, e.user_id
      LIMIT 1),
    (SELECT COALESCE(array_agg(u.name ORDER BY u.name), '{}'::text[])
       FROM public.users u WHERE u.id = ANY(v_payers)),
    auth.uid() = ANY(v_payers),
    -- The CALLER's own switch, which is what a toggle shows. Non-payers have no
    -- row and read the default (on); can_toggle tells the UI whether to show it.
    COALESCE(
      (SELECT sw.enabled FROM public.move_pro_switches sw
        WHERE sw.move_id = p_move_id AND sw.payer_id = auth.uid()),
      true
    ),
    EXISTS (
      SELECT 1 FROM public.user_entitlements e
       WHERE e.user_id = auth.uid() AND e.plan = 'pro' AND e.period_end > now()
    );
END;
$$;

-- ── Photo gate: the corrected version of 013 ──
-- 013 asked whether the MOVE OWNER held Pro. That meant a paying member's
-- subscription granted their own move nothing at all. The question is now the
-- one the feature was always about: is Pro active in the move this box is in?
CREATE OR REPLACE FUNCTION public.enforce_box_photo_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  photo_count INT;
BEGIN
  PERFORM 1 FROM public.boxes WHERE id = NEW.box_id FOR UPDATE;
  SELECT COUNT(*) INTO photo_count FROM public.box_photos WHERE box_id = NEW.box_id;
  -- Deterministic ordering: the slot is assigned while the box row is locked,
  -- so concurrent inserts can never produce duplicate sort_order values.
  NEW.sort_order := photo_count;
  IF photo_count >= 3 THEN
    RAISE EXCEPTION 'MAX_PHOTOS_PER_BOX';
  END IF;

  -- Pro is shared with the move: ANY active member's active subscription is
  -- enough for everybody in it. Deny-by-default while a period_end has passed.
  IF NOT public.move_is_pro(public.move_of_box(NEW.box_id)) THEN
    RAISE EXCEPTION 'PHOTOS_REQUIRE_PRO';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_box_photo_limit_trigger ON public.box_photos;
CREATE TRIGGER enforce_box_photo_limit_trigger
  BEFORE INSERT ON public.box_photos
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_box_photo_limit();

-- ============================================
-- 6) Credits — one pool per subscriber, shared with every move they cover
--
-- There is NO new pool table. A subscriber's own pro bucket IS the pool: that
-- keeps 014's two-bucket model exactly as it is, keeps the RevenueCat webhook
-- untouched (it already tops up that bucket on purchase and renewal), and means
-- a second subscriber in a move simply adds a second bucket — which is what
-- "credits stack per subscriber" means, with no extra bookkeeping.
-- ============================================

-- ── 6a) Ledger attribution ─────────────────
-- The invariant (SUM(delta) per user+bucket === that bucket's balance) is what
-- makes the ledger auditable, so a pooled spend still moves the BALANCE OWNER's
-- column: user_id = the subscriber whose credits were spent. WHO spent them is
-- recorded separately in spent_by, with move_id for context — which is what
-- makes "Rahul used 34 recordings" answerable without breaking the invariant.
ALTER TABLE public.credit_ledger
  ADD COLUMN IF NOT EXISTS move_id  UUID REFERENCES public.moves(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS spent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_credit_ledger_move_spend
  ON public.credit_ledger(move_id, spent_by, created_at);

-- A spender may read the rows they caused even when the bucket belongs to
-- somebody else (the family-pool case) — their usage, their visibility.
DROP POLICY IF EXISTS "Users can read own credit ledger" ON public.credit_ledger;
CREATE POLICY "Users can read own credit ledger"
  ON public.credit_ledger FOR SELECT
  USING (user_id = auth.uid() OR spent_by = auth.uid());

-- ── 6b) Live totals ─────────────────────────

/** free_balance plus a LIVE pro window. An expired window contributes 0 at
 *  read time, so nothing has to be zeroed before it can be believed. */
CREATE OR REPLACE FUNCTION public.user_live_credits(p_user_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(free_balance, 0)
       + CASE WHEN pro_expires_at IS NOT NULL AND pro_expires_at > now()
              THEN COALESCE(pro_balance, 0) ELSE 0 END
    FROM public.user_credits
   WHERE user_id = p_user_id;
$$;

/** Credits available to a move from its covering subscribers, right now. */
CREATE OR REPLACE FUNCTION public.move_credit_pool(p_move_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
  SELECT COALESCE(sum(c.pro_balance), 0)::int
    FROM public.user_credits c
   WHERE c.user_id = ANY (public.move_pro_payers(p_move_id))
     AND c.pro_expires_at IS NOT NULL
     AND c.pro_expires_at > now();
$$;

/** The shared pool as seen by the app (members only). */
CREATE OR REPLACE FUNCTION public.get_move_credit_pool(p_move_id uuid)
RETURNS int
LANGUAGE plpgsql
STABLE
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_move_member(p_move_id) THEN
    RAISE EXCEPTION 'NOT_MOVE_MEMBER';
  END IF;

  RETURN public.move_credit_pool(p_move_id);
END;
$$;

-- ── 6c) consume_voice_credit — spend the pool first ──
-- The old 2-argument signature is DROPPED rather than kept as an overload:
-- PostgREST must never have two candidates to choose between (the same reason
-- 016 and 019 drop before they create).
DROP FUNCTION IF EXISTS public.consume_voice_credit(uuid, text);

/**
 * Spend one credit for a voice recording.
 *
 * p_box_id is the box the recording is collecting items into (nullable for
 * callers that have no box context). The MOVE is resolved from it inside this
 * function — never taken from the caller — so a member can only ever spend a
 * pool they actually belong to.
 *
 * Order: the move's shared pool (earliest-expiring first, i.e. the array's
 * primary payer, then anyone else covering the move) → the caller's own pro
 * bucket → the caller's own free bucket. Unchanged for anyone not in a covered
 * move.
 *
 * Returns the credits the caller can still spend from where the charge landed:
 * the family pool total for a pooled spend, otherwise their own live total.
 */
CREATE OR REPLACE FUNCTION public.consume_voice_credit(
  p_user_id      uuid,
  p_operation_id text,
  p_box_id       uuid DEFAULT NULL
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_move    uuid;
  v_payer   uuid;
  v_balance int;
  v_row     public.user_credits%ROWTYPE;
  v_bucket  text;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Idempotent: this operation already consumed → no double charge.
  --
  -- The lookup is by operation_id ALONE, not by user_id: once a charge can land
  -- on somebody else's bucket (the shared pool), the row's user_id is the
  -- subscriber who paid, and keying the guard on the caller would have let a
  -- retried request charge the pool a second time. uq_ledger_consume_op makes
  -- operation_id globally unique for consumes, so this is exact.
  SELECT move_id INTO v_move
    FROM public.credit_ledger
   WHERE operation_id = p_operation_id
     AND reason = 'voice_consume'
   LIMIT 1;
  IF FOUND THEN
    IF v_move IS NOT NULL AND public.move_is_pro(v_move) THEN
      RETURN public.move_credit_pool(v_move);
    END IF;
    RETURN COALESCE(public.user_live_credits(p_user_id), 0);
  END IF;

  v_move := NULL;

  -- Which move is this for? Derived from the box, then membership-checked.
  IF p_box_id IS NOT NULL THEN
    v_move := public.move_of_box(p_box_id);
    IF v_move IS NOT NULL AND NOT public.is_move_member_for(v_move, p_user_id) THEN
      RAISE EXCEPTION 'NOT_A_MEMBER';
    END IF;
  END IF;

  BEGIN
    -- ── 1) The move's shared pool — perishable, so it is spent first ──
    IF v_move IS NOT NULL AND public.move_is_pro(v_move) THEN
      FOREACH v_payer IN ARRAY public.move_pro_payers(v_move) LOOP
        -- Lock the contributor's row so two members recording at the same
        -- moment can never overdraw the same bucket.
        SELECT * INTO v_row FROM public.user_credits
         WHERE user_id = v_payer
           FOR UPDATE;

        IF FOUND THEN
          PERFORM public.expire_pro_credits_if_due_for(v_payer);

          v_balance := NULL;
          UPDATE public.user_credits
             SET pro_balance = pro_balance - 1,
                 updated_at  = now()
           WHERE user_id = v_payer
             AND pro_expires_at IS NOT NULL
             AND pro_expires_at > now()
             AND pro_balance > 0
          RETURNING pro_balance INTO v_balance;

          IF v_balance IS NOT NULL THEN
            INSERT INTO public.credit_ledger
              (user_id, delta, reason, operation_id, bucket, move_id, spent_by)
            VALUES
              (v_payer, -1, 'voice_consume', p_operation_id, 'pro', v_move, p_user_id);

            RETURN public.move_credit_pool(v_move);
          END IF;
        END IF;
      END LOOP;
    END IF;

    -- ── 2) The caller's own buckets: pro first, then free ──
    INSERT INTO public.user_credits (user_id) VALUES (p_user_id)
      ON CONFLICT (user_id) DO NOTHING;

    PERFORM public.expire_pro_credits_if_due_for(p_user_id);

    SELECT * INTO v_row FROM public.user_credits
     WHERE user_id = p_user_id
       FOR UPDATE;

    IF v_row.pro_balance > 0
       AND v_row.pro_expires_at IS NOT NULL
       AND v_row.pro_expires_at > now() THEN
      v_bucket := 'pro';
    ELSIF v_row.free_balance > 0 THEN
      v_bucket := 'free';
    ELSE
      RAISE EXCEPTION 'OUT_OF_CREDITS';
    END IF;

    UPDATE public.user_credits
       SET free_balance = CASE WHEN v_bucket = 'free' THEN free_balance - 1 ELSE free_balance END,
           pro_balance  = CASE WHEN v_bucket = 'pro'  THEN pro_balance  - 1 ELSE pro_balance  END,
           updated_at   = now()
     WHERE user_id = p_user_id;

    INSERT INTO public.credit_ledger
      (user_id, delta, reason, operation_id, bucket, move_id, spent_by)
    VALUES
      (p_user_id, -1, 'voice_consume', p_operation_id, v_bucket, v_move, p_user_id);

    RETURN COALESCE(public.user_live_credits(p_user_id), 0);

  EXCEPTION
    WHEN unique_violation THEN
      -- Concurrent consume with the same operation_id: rolled back above.
      RETURN COALESCE(public.user_live_credits(p_user_id), 0);
  END;
END;
$$;

-- ── 6d) refund_voice_credit — back to the bucket it came from ──
-- Signature unchanged from 014 on purpose: the Edge Function's retry path calls
-- it with the same two arguments it always did.
CREATE OR REPLACE FUNCTION public.refund_voice_credit(
  p_user_id      uuid,
  p_operation_id text
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_owner  uuid;
  v_bucket text;
  v_move   uuid;
  v_spent  uuid;
  v_total  int;
BEGIN
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_ARGUMENTS';
  END IF;

  -- Whose credits were they, which bucket did they leave, and for which move?
  SELECT user_id, bucket, move_id, spent_by
    INTO v_owner, v_bucket, v_move, v_spent
    FROM public.credit_ledger
   WHERE operation_id = p_operation_id
     AND reason = 'voice_consume'
   LIMIT 1;

  IF NOT FOUND THEN
    -- Nothing was consumed (or it is long gone): nothing to refund.
    RETURN COALESCE(public.user_live_credits(p_user_id), 0);
  END IF;

  -- Only once per operation.
  PERFORM 1 FROM public.credit_ledger
    WHERE operation_id = p_operation_id
      AND reason = 'voice_refund';
  IF FOUND THEN
    IF v_move IS NOT NULL AND public.move_is_pro(v_move) THEN
      RETURN public.move_credit_pool(v_move);
    END IF;
    RETURN COALESCE(public.user_live_credits(p_user_id), 0);
  END IF;

  INSERT INTO public.user_credits (user_id) VALUES (v_owner)
    ON CONFLICT (user_id) DO NOTHING;

  -- A refund into a DEAD pro window would strand an unusable credit: land it in
  -- the owner's free bucket instead (014's rule, now for shared pools too).
  IF v_bucket = 'pro'
     AND EXISTS (
       SELECT 1 FROM public.user_credits
        WHERE user_id = v_owner
          AND pro_expires_at IS NOT NULL
          AND pro_expires_at <= now()
     ) THEN
    v_bucket := 'free';
  END IF;

  UPDATE public.user_credits
     SET free_balance = CASE WHEN v_bucket = 'free' THEN free_balance + 1 ELSE free_balance END,
         pro_balance  = CASE WHEN v_bucket = 'pro'  THEN pro_balance  + 1 ELSE pro_balance  END,
         updated_at   = now()
   WHERE user_id = v_owner;

  INSERT INTO public.credit_ledger
    (user_id, delta, reason, operation_id, bucket, move_id, spent_by)
  VALUES
    (v_owner, 1, 'voice_refund', p_operation_id, v_bucket, v_move, COALESCE(v_spent, p_user_id));

  -- Report what the spender can use now: the pool if the move is still covered.
  IF v_move IS NOT NULL AND public.move_is_pro(v_move) THEN
    RETURN public.move_credit_pool(v_move);
  END IF;

  SELECT COALESCE(public.user_live_credits(p_user_id), 0) INTO v_total;
  RETURN v_total;
END;
$$;

-- ============================================
-- 7) Permissions
--
-- Functions default to EXECUTE for PUBLIC, so everything that is meant to be
-- internal is revoked explicitly rather than left reachable.
-- ============================================

-- Called from INSIDE RLS policies, so the querying role itself needs EXECUTE.
-- (They are SECURITY DEFINER, so a policy never has to see the table again.)
GRANT EXECUTE ON FUNCTION public.is_move_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_move_joiner(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_box_member(uuid) TO authenticated;

-- Internal plumbing: called by other SECURITY DEFINER functions and by the
-- photo trigger, never by a client.
REVOKE EXECUTE ON FUNCTION public.is_move_member_for(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.is_move_owner(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_of_box(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_pro_payers(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_is_pro(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.move_credit_pool(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.user_live_credits(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_invite_code() FROM PUBLIC, anon, authenticated;

-- Client RPCs: signed-in users only. Each one re-checks the caller inside.
REVOKE EXECUTE ON FUNCTION public.request_to_join_move(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_to_join_move(text) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.approve_move_join(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_move_join(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.deny_move_join(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.deny_move_join(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.remove_move_member(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.remove_move_member(uuid, uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.rotate_invite_code(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_invite_code(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_move_join_requests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_move_join_requests(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.move_plan(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_plan(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.set_move_pro_enabled(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_move_pro_enabled(uuid, boolean) TO authenticated;

REVOKE EXECUTE ON FUNCTION public.get_move_credit_pool(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_move_credit_pool(uuid) TO authenticated;

-- Credits stay service-role only, exactly as in 010/013/014: the Edge Function
-- verifies the caller from their JWT and passes the user id in.
REVOKE EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_voice_credit(uuid, text, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ============================================
-- Reversal (run to undo this migration)
-- ============================================
-- -- 7) permissions back to the 001/013/014 grants
-- GRANT EXECUTE ON FUNCTION public.refund_voice_credit(uuid, text) TO service_role;
--
-- -- 6) credits back to the 014 bodies
-- DROP FUNCTION IF EXISTS public.consume_voice_credit(uuid, text, uuid);
-- (then re-run 014's create for consume_voice_credit, refund_voice_credit,
--  user_live_credits does not exist in 014 — drop it too)
-- ALTER TABLE public.credit_ledger DROP COLUMN IF EXISTS spent_by;
-- ALTER TABLE public.credit_ledger DROP COLUMN IF EXISTS move_id;
--
-- -- 5) Pro
-- DROP TRIGGER IF EXISTS enforce_box_photo_limit_trigger ON public.box_photos;
-- (then re-run 013's enforce_box_photo_limit to restore the owner-anchored gate)
-- DROP TABLE IF EXISTS public.move_pro_switches;
-- DROP FUNCTION IF EXISTS public.set_move_pro_enabled(uuid, boolean);
-- DROP FUNCTION IF EXISTS public.move_plan(uuid);
-- DROP FUNCTION IF EXISTS public.move_is_pro(uuid);
-- DROP FUNCTION IF EXISTS public.move_pro_payers(uuid);
--
-- -- 4) join requests
-- DROP FUNCTION IF EXISTS public.request_to_join_move(text);
-- DROP FUNCTION IF EXISTS public.approve_move_join(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.deny_move_join(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.remove_move_member(uuid, uuid);
-- DROP FUNCTION IF EXISTS public.rotate_invite_code(uuid);
-- DROP FUNCTION IF EXISTS public.generate_invite_code();
-- DROP FUNCTION IF EXISTS public.get_move_join_requests(uuid);
-- DROP TABLE IF EXISTS public.move_join_requests;
--
-- -- 3) policies back to their 001/006/009 predicates, then:
-- ALTER PUBLICATION supabase_realtime DROP TABLE public.move_pro_switches;
-- (move_members stays published; it is harmless either way)
--
-- -- 2) helpers
-- DROP FUNCTION IF EXISTS public.is_box_member(uuid);
-- DROP FUNCTION IF EXISTS public.move_of_box(uuid);
-- DROP FUNCTION IF EXISTS public.is_move_owner(uuid);
-- DROP FUNCTION IF EXISTS public.is_move_joiner(uuid);
-- DROP FUNCTION IF EXISTS public.is_move_member(uuid);
-- DROP FUNCTION IF EXISTS public.is_move_member_for(uuid, uuid);
