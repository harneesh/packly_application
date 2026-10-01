-- ============================================
-- 021 — verification kit
-- Run section by section in the Supabase SQL editor.
-- ============================================
--
-- Nothing here changes anything for good: every mutating section runs inside
-- BEGIN; ... ROLLBACK;
--
-- Two different "who am I" mechanisms are in play, and they are not the same:
--
--   * The SQL editor runs as `postgres`, which BYPASSES RLS. So RLS can only
--     be exercised after `SET LOCAL ROLE authenticated`.
--   * The SECURITY DEFINER RPCs do NOT need that switch. They read auth.uid()
--     from `request.jwt.claims`, so setting that GUC is enough to act as a
--     given user — which is why the round-trip test below can drive both
--     sides (requester and owner) from one session.

-- ────────────────────────────────────────────
-- 1) Are all the objects in place?
-- ────────────────────────────────────────────
SELECT p.proname, pg_get_function_arguments(p.oid) AS args
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public'
   AND p.proname IN (
     'request_to_join_move', 'approve_move_join', 'deny_move_join',
     'remove_move_member', 'rotate_invite_code', 'generate_invite_code',
     'get_move_join_requests', 'get_move_members',
     'is_move_member', 'is_move_member_for', 'is_move_joiner',
     'is_move_owner', 'is_box_member', 'move_of_box',
     'move_plan', 'move_is_pro', 'move_pro_payers', 'set_move_pro_enabled',
     'move_credit_pool', 'get_move_credit_pool', 'user_live_credits',
     'consume_voice_credit', 'refund_voice_credit', 'enforce_box_photo_limit'
   )
 ORDER BY p.proname, args;
-- Expect exactly ONE consume_voice_credit row, three arguments (uuid, text, uuid).
-- Two rows means the old 2-argument overload survived the DROP and PostgREST
-- would have two candidates — fix before shipping.

SELECT table_name
  FROM information_schema.tables
 WHERE table_schema = 'public'
   AND table_name IN ('move_join_requests', 'move_pro_switches');
-- Expect 2 rows.

-- ────────────────────────────────────────────
-- 2) The property, stated exactly: no policy may READ move_members without
--    going through a helper function.
-- ────────────────────────────────────────────
SELECT tablename, policyname, cmd,
       (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
         ~ 'is_(move|box)_(member|joiner|owner)'                    AS through_helper,
       regexp_replace(coalesce(nullif(qual, ''), with_check, ''),
                      '\s+', ' ', 'g')                              AS predicate
  FROM pg_policies
 WHERE schemaname = 'public'
   AND (coalesce(qual, '') || coalesce(with_check, '')) LIKE '%move_members%'
 ORDER BY through_helper, tablename, policyname;
-- Expect EXACTLY TWO rows, both through_helper = true:
--
--   move_members | Members can view move members                  (is_move_member)
--   users        | Members can view profiles of move collaborators
--                |   (... OR EXISTS (SELECT 1 FROM move_members mm
--                |        WHERE mm.user_id = users.id
--                |          AND public.is_move_member(mm.move_id)))
--
-- A third row, on any other table, is the failure this migration exists to
-- prevent. A row with through_helper = false is worse: the rule hand-written.

-- ────────────────────────────────────────────
-- 2b) The same picture, every policy at once
-- ────────────────────────────────────────────
SELECT tablename, policyname, cmd,
       coalesce(nullif(qual, ''), with_check, '') LIKE '%move_members%'
                                                                    AS reads_move_members,
       (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
         ~ 'is_(move|box)_(member|joiner|owner)'                    AS uses_helper,
       regexp_replace(coalesce(nullif(qual, ''), with_check, ''),
                      '\s+', ' ', 'g')                              AS predicate
  FROM pg_policies
 WHERE schemaname = 'public'
   AND tablename IN ('moves', 'move_members', 'rooms', 'boxes', 'items',
                     'box_photos', 'move_join_requests', 'move_pro_switches', 'users')
 ORDER BY uses_helper, tablename, policyname;
-- uses_helper = false is EXPECTED on exactly one class of policy: the ones that
-- test the CALLER against the row they are already guarding, which needs no
-- membership lookup at all —
--     move_members | Members can leave moves    (user_id = auth.uid())
--     moves        | Owners can update/delete   (owner_id = auth.uid())
--     moves        | Users can create moves      (owner_id = auth.uid())
--     users        | Users can … own profile     (id = auth.uid())
-- Everything guarding data INSIDE a move must be true: rooms, boxes, items,
-- box_photos, moves SELECT, move_members SELECT/INSERT, move_pro_switches and
-- move_join_requests. One of those reading false, or any row that both reads
-- move_members and skips the helper, is a check that was missed.

-- ────────────────────────────────────────────
-- 3) The Pro gate, computed for your newest moves
-- ────────────────────────────────────────────
SELECT m.name,
       m.id,
       public.move_is_pro(m.id)      AS move_is_pro,
       public.move_pro_payers(m.id)  AS payers,
       public.move_credit_pool(m.id) AS pool
  FROM public.moves m
 ORDER BY m.created_at DESC
 LIMIT 3;
-- move_is_pro false + pool 0 for a move you pay for = the plan is not covering
-- it (check user_entitlements.period_end, and whether the switch is off).

-- ────────────────────────────────────────────
-- 4) RLS: the owner keeps access, a non-member gets nothing
-- ────────────────────────────────────────────
BEGIN;

-- (a) as the owner of the newest move
SELECT set_config('request.jwt.claims',
  json_build_object(
    'sub',  (SELECT owner_id::text FROM public.moves ORDER BY created_at DESC LIMIT 1),
    'role', 'authenticated'
  )::text, true);

SET LOCAL ROLE authenticated;
SELECT count(*) AS owner_sees_moves FROM public.moves;         -- >= 1
SELECT * FROM public.move_plan(
  (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1)
);                                                             -- must return a row
RESET ROLE;

-- (b) as somebody who belongs to no move at all
SELECT set_config('request.jwt.claims',
  json_build_object(
    'sub', (SELECT u.id::text FROM public.users u
             WHERE NOT EXISTS (
               SELECT 1 FROM public.move_members mm WHERE mm.user_id = u.id
             ) LIMIT 1),
    'role', 'authenticated'
  )::text, true);

SET LOCAL ROLE authenticated;
SELECT count(*) AS stranger_sees_moves   FROM public.moves;          -- 0
SELECT count(*) AS stranger_sees_members FROM public.move_members;   -- 0
SELECT count(*) AS stranger_sees_boxes   FROM public.boxes;          -- 0
SELECT count(*) AS stranger_sees_items   FROM public.items;          -- 0
RESET ROLE;

ROLLBACK;

-- ────────────────────────────────────────────
-- 5) The join → approve round trip
-- ────────────────────────────────────────────
-- If step (a) raises NOT_AUTHENTICATED, every user in public.users already
-- belongs to a move — invite a spare account (or skip this section).
BEGIN;

-- (a) a stranger asks to join using the newest invite code.
--     Run this twice: the second call must NOT duplicate the request.
SELECT set_config('request.jwt.claims',
  json_build_object(
    'sub', (SELECT u.id::text FROM public.users u
             WHERE NOT EXISTS (
               SELECT 1 FROM public.move_members mm WHERE mm.user_id = u.id
             ) LIMIT 1),
    'role', 'authenticated'
  )::text, true);

SELECT public.request_to_join_move(
  (SELECT invite_code FROM public.moves ORDER BY created_at DESC LIMIT 1)
) AS requester_result;      -- {"status":"pending"}

SELECT count(*) AS pending_requests
  FROM public.move_join_requests
 WHERE move_id = (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1);
                            -- 1, even after running the call twice

-- A requester is NOT a member yet: the move row stays invisible to them.
SET LOCAL ROLE authenticated;
SELECT count(*) AS requester_sees_move
  FROM public.moves
 WHERE id = (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1);  -- 0
RESET ROLE;

-- (b) the owner sees the queue and approves
SELECT set_config('request.jwt.claims',
  json_build_object(
    'sub',  (SELECT owner_id::text FROM public.moves ORDER BY created_at DESC LIMIT 1),
    'role', 'authenticated'
  )::text, true);

SELECT * FROM public.get_move_join_requests(
  (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1)
);                          -- the requester, with name and email

SELECT public.approve_move_join(
  (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1),
  (SELECT user_id FROM public.move_join_requests
    WHERE move_id = (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1)
    LIMIT 1)
) AS approved;

SELECT count(*) AS requests_left
  FROM public.move_join_requests
 WHERE move_id = (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1);
                            -- 0 — approving consumes the request

-- (c) the freshly added member can now read the move and the plan
SELECT set_config('request.jwt.claims',
  json_build_object(
    'sub', (SELECT mm.user_id::text FROM public.move_members mm
             WHERE mm.move_id = (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1)
               AND mm.user_id <> (SELECT owner_id FROM public.moves ORDER BY created_at DESC LIMIT 1)
             LIMIT 1),
    'role', 'authenticated'
  )::text, true);

SELECT * FROM public.move_plan(
  (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 1)
);                          -- must NOT raise NOT_MOVE_MEMBER

SELECT public.request_to_join_move(
  (SELECT invite_code FROM public.moves ORDER BY created_at DESC LIMIT 1)
) AS asking_again;          -- {"status":"active"} — idempotent for a member

ROLLBACK;
-- Everything above is undone: no member was actually added, no request left
-- behind.

-- ────────────────────────────────────────────
-- 6) Photos: is each move covered?
-- ────────────────────────────────────────────
-- Nothing to paste: this picks boxes for you and shows the gate answer for the
-- move each one lives in.
--
--   photos_allowed = true  → the upload trigger accepts photos from EVERY
--                            member of that move, not just the owner
--   photos_allowed = false → it raises PHOTOS_REQUIRE_PRO for everyone there
--
-- (The owner-only behaviour was the bug: before 021 the gate asked whether the
-- move's OWNER held Pro, so a paying member's subscription granted the move
-- nothing.)
SELECT m.name                   AS move,
       r.name                   AS room,
       b.box_number,
       b.is_packed,
       public.move_is_pro(m.id) AS photos_allowed
  FROM public.boxes b
  JOIN public.rooms r ON r.id = b.room_id
  JOIN public.moves m ON m.id = r.move_id
 ORDER BY m.created_at DESC, r.name, b.box_number
 LIMIT 15;

-- Why is a move Free? Every Pro row in the database and whether it reaches the
-- move: `live` is the paid period, and move_pro_payers() needs live AND
-- member_of_move AND sharing_on to count it.
SELECT m.name                                       AS move,
       e.user_id                                    AS subscriber,
       e.period_end,
       (e.period_end > now())                       AS live,
       public.is_move_member_for(m.id, e.user_id)   AS member_of_move,
       COALESCE((SELECT sw.enabled FROM public.move_pro_switches sw
                  WHERE sw.move_id = m.id AND sw.payer_id = e.user_id), true)
                                                    AS sharing_on
  FROM public.moves m
  CROSS JOIN public.user_entitlements e
 WHERE e.plan = 'pro'
   AND m.id IN (SELECT id FROM public.moves ORDER BY created_at DESC LIMIT 3)
 ORDER BY m.created_at DESC, e.period_end DESC NULLS LAST;
