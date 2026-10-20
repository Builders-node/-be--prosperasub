# NestJS → Supabase migration

The NestJS API (`backend/src`, api.prosperasub.com) is being moved into
Supabase one piece at a time, then deleted. Nothing is switched in one go.

## How a piece moves

- **HTTP endpoints** go into one Edge Function, `api`
  (`functions/api`, deployed with `verify_jwt = false`), under the SAME path the
  Nest controller used. The frontend sends a path there once its pattern is in
  `EDGE_ROUTES` in `frontend/src/integrations/supabase/config.ts`; everything
  else still goes to `API_URL`. Rolling back is deleting that line.
- **Auth** on Edge verifies the same HS256 access tokens Nest issues
  (`lib/auth.ts`: `requireAccount`, `requireAdmin` → SQL
  `edge_admin_allowed`), so a session works on both during the move.
- **Crons** become `pg_cron` jobs: plain SQL when the work is already a
  function, `pg_net` → Edge Function when it is not.
- **Deploy**: `mcp__supabase__deploy_edge_function` (or `supabase functions
  deploy api`). Migrations live in `migrations/`, applied to production.

## Secrets the Edge Function needs (Supabase → Edge Functions → Secrets)

Never committed. Until one is set, the routes that need it answer 503 instead
of failing open.

**Vercel will not give them back.** The API's env vars are marked sensitive, so
`vercel env pull` returns an 11-character placeholder for all 33 of them. The
ones set so far (2026-10-20) came from `backend/.env`, after proving each one
live: `JWT_ACCESS_SECRET` by signing a probe token that production accepted,
Resend/Telegram by a read-only API call. `JWT_VERIFY_SECRET` was not local, so a
NEW one was generated — fine, because access-QR tokens live 5 minutes and both
`/verify/token` and `/verify-access` must move together. Set:
`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_VERIFY_SECRET` (new),
`RESEND_API_KEY` (send-only key), `MAIL_FROM`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ADMIN_CHAT_ID`, `ADMIN_PAYMENT_NOTIFICATION_EMAIL`, `BUSINESS_TIMEZONE`.
Production has no `SUPPORT_INBOX_EMAIL`/`MAIL_REPLY_TO`, so support mail has
never been sent — same on Edge until one is set.

| Secret | Needed for |
|---|---|
| `JWT_ACCESS_SECRET` | every signed-in route |
| `JWT_REFRESH_SECRET` | auth/refresh (when auth moves) |
| `JWT_VERIFY_SECRET` | access QR, password reset |
| `RESEND_API_KEY`, `MAIL_FROM`, `MAIL_REPLY_TO` | all email |
| `SUPPORT_INBOX_EMAIL`, `ADMIN_PAYMENT_NOTIFICATION_EMAIL` | support + payment alerts |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID` | payment alerts |
| `GOOGLE_*` | calendars, Google sign-in |
| `BLINK_*`, `PAYPAL_*`, `NOWPAYMENTS_*` | payments (moved last) |
| `CRON_SECRET` | pg_net → Edge cron calls |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are injected by Supabase.

## Status

| # | Piece | State |
|---|---|---|
| 0 | Dead endpoints (57, see inventory) | to delete, not port |
| 1 | Cron `seed-cleaning-slots` | **moved** — pg_cron `10 5 * * *` → `seed_cleaning_slots(180)` |
| 1 | `GET /health` | **moved** — Edge `api`, routed |
| 1 | Edge `api` skeleton, auth, admin RBAC fn | **done** |
| 2 | Analytics `/analytics/summary`, `/analytics/revenue` | **moved** — byte-identical to Nest |
| 3 | Support `/support/messages`, `/admin/support/messages[/:id]` | **moved** (mail lib ported) |
| 3 | Mail `/mail/*`, notifications | next |
| 4 | Verify `/verify/token` + `/verify-access`, Membership PDP (`lib/membership.ts`) | **moved** together — decisions identical on 5 real users (1 allowed, 4 denied) |
| 5 | Account CRUD (locations, members, …) | |
| 6 | Event outbox, expire-holds → pg_cron | |
| 7 | Google Calendar | |
| 8 | Booking engine, orders, membership | |
| 9 | Admin (non-money) | |
| 10 | Auth itself (login, signup, Google, refresh, reset) | |
| 11 | Food, renewals, subscription lifecycle cron | |
| 12 | Payments in: invoices, webhooks, settlement, reconcile, rentals | |
| 13 | Money out: payouts, refunds, credits | last |
| 14 | Builders Node partner API | with the partner |

Then: remove the Vercel crons, delete `backend/src` and the
`prospera-sub-api` Vercel project, move `backend/supabase` to the repo root.

## Bugs found while inventorying — fix in the port, do not copy

- CronGuard lets everything through when `CRON_SECRET` is unset.
- Status endpoints never mark rows paid (the browser does); on-chain trusts the
  client's sats; PayPal ledger rows have a null amount.
- Blink webhook is unsigned; `/rentals/bookings/:id/confirm` bypasses settlement.
- Payout decision can overwrite a payout mid-send; PayPal refund has no
  double-refund guard.
- `GET /orders/:id` and `GET /booking/by-provider` lack ownership checks;
  `GET /booking/bookings` is public with user refs and notes;
  `POST /booking/holds/:id/confirm` has no ownership/payment check.
- Booking staff checks compare lowercase role names to uppercase token roles.
- `beach-courts/pull-google` may cancel app-made court bookings.
- Renewals never compare paid amount to price; a reference can renew twice.
- `generate_food_occurrences` is called with no provider filter.
- Cleaning reschedule and Builders Node booking bump `current_bookings` with a
  read-then-write race.
