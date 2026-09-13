# Bayview Boarding — Project Brief for Claude

## What this is
A React web app for Bayview Boarding, a home-based dog boarding business run by 
Kim Miller and Estee Fletter at 210 Bayview Drive, San Rafael, CA.

## What it does
- Client intake form (5 steps: owner info, dog info, stay dates, waiver, signature)
- Electronic waiver with e-signature (legally binding under E-SIGN / UETA)
- Supabase database saves all submissions
- Phone-number-based returning client lookup
- Cost estimate based on drop-off/pick-up times at $105/day, +30% on holiday
  nights (computed algorithmically, see calcCost/getHolidayWindows in
  src/App.js), 10% off each additional dog's nightly rate (uncapped) via a
  "Number of Dogs" field on Step 2 — full intake is still collected for the
  primary dog only
- Twilio SMS confirmation texts (pending A2P carrier approval)
- Admin panel with stay history per dog, reached only via a bookmarked URL
  (?admin) — no visible Admin button in the UI

## Tech stack
- React (Create React App)
- Supabase (database + Edge Functions)
- Twilio (SMS via send-confirmation Edge Function)
- GitHub Pages hosting (kimardenmiller.github.io/bayview-boarding)
- Admin password: set as the `ADMIN_PASSWORD` Supabase secret (`supabase secrets set ADMIN_PASSWORD=...`) — never in source, checked server-side by the admin-data function
- Twilio phone: see src/settings.js PHONE (business's own public contact number)

## Key files
- src/App.js — main app
- src/settings.js — all configurable values (rates, vets, messages, packing list)
- src/waiver.js — full waiver text
- src/App.test.js — 74 passing tests (TDD), Supabase mocked via src/__mocks__/supabase.js
- supabase/functions/send-confirmation/index.ts — Twilio SMS function (outbound)
- supabase/functions/receive-sms/index.ts — inbound SMS webhook: auto-reply + relay to Kim/Estee. Deploy with `--no-verify-jwt` (see comment at top of file) or Twilio's webhook calls silently fail
- supabase/functions/_shared/contact.ts — pure text builders + Twilio signature validator, shared by send-confirmation and receive-sms, unit-tested via `deno test`
- supabase/functions/admin-data/index.ts — server-side admin password check + full stay data (service role key, never exposed to client)
- supabase/functions/lookup-client/index.ts — returning-client autofill by phone (returns only safe fields, not full record)
- supabase/migrations/ — RLS policy history for the `stays` table
- FIXES.txt — current fix list and backlog

## Security notes
- This is a static, client-side-only app (GitHub Pages, no server) — anything
  in the JS bundle is public. Never put secrets (passwords, API keys) directly
  in App.js/settings.js again; they must live server-side as Supabase secrets
  and be checked from an Edge Function.
- `stays` RLS only allows anon `INSERT` (the booking form). All reads go
  through Edge Functions using the service role key. Do not re-add a public
  SELECT/UPDATE/DELETE policy on `stays` without a real reason — this table
  holds client PII (names, phone, email, signatures, health/aggression notes).

## Current priorities (v1.5)
1. Stay reminder SMS — cron job 24hrs before drop-off
2. Billing SMS — admin triggers from stay detail view
3. Rate persistence — save to Supabase so it survives page refresh
4. Persist admin rate setting to Supabase settings table
5. Signature timestamp — add client timezone

## Rules
- Always run tests before committing (npm test -- --watchAll=false)
- All configurable values go in src/settings.js
- Follow TDD — write tests before new features
- Commit messages use format: "v1.x - description"
