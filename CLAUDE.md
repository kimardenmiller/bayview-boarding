# Bayview Boarding — Project Brief for Claude

## What this is
A React web app for Bayview Boarding, a home-based dog boarding business run by 
Kim Miller and Estee Fletter at 210 Bayview Drive, San Rafael, CA.

## What it does
- Client intake form, a dynamic number of steps: owner info (name/phone/
  email/vet/"Number of Dogs"), one full-profile page per dog ("Dog 1",
  "Dog 2", ... — breed/DOB/spay-neuter/aggression/health), stay dates,
  waiver, signature. Vet and dog count are asked once on the owner page,
  not per dog (Sept 14 reorg, moved off the dog page Sept 15)
- Aggression/health questions warn visibly if left blank (previously
  required to advance but silently so - no message ever showed)
- Electronic waiver with e-signature (legally binding under E-SIGN / UETA)
- Supabase database saves all submissions
- Phone-number-based returning client lookup (Owner page's "Look up"
  button) — autofills name/email/vet and every known dog on file, growing
  the dog-page count to match
- Cost estimate based on drop-off/pick-up times at an admin-configurable
  day rate (default $105/day), holiday upcharge (default +30%), and
  multi-dog discount (default 10% off each additional dog's nightly rate,
  uncapped) — all three, plus the vet clinic list, are loaded from
  Supabase on every page load (public read) and editable in the admin
  panel (Sept 15 (4) — see Data model below)
- Past check-in dates are rejected, client-side (StepDates) and
  server-side (submit-booking, the actual boundary); a same-day stay's
  pick-up must be after its drop-off (no such constraint across days)
- Twilio SMS confirmation texts (pending A2P carrier approval)
- Admin panel: browse by dog, each with its always-current profile and full
  stay history (each past stay shows its own frozen declared/signed
  snapshot, not just the dog's latest profile — see Data model below).
  Reached only via a bookmarked URL (?admin) — no visible Admin button in
  the UI

## Data model (Sept 14, 2026 reorg)
`owners` (by phone) → `dogs` (owner's always-current profile) → `stays`
(one per booking) ← `stay_dogs` (join table; which dogs were on a stay,
each carrying its OWN frozen snapshot of that dog's profile as declared
and signed for that specific booking — deliberately separate from `dogs`,
since a later booking can update the profile without rewriting history).
The pre-reorg flat `stays` table (one row per booking, one dog's full
profile embedded directly) is kept as `stays_legacy` for reference; see
supabase/migrations/20260914000000_dog_profiles_reorg.sql for the full
rationale and the backfill that migrated existing data into the new shape.
Since find-or-create-by-phone/name needs a SELECT anon doesn't have, all
booking writes go through submit-booking (service role key) instead of a
direct client insert — see supabase/functions/submit-booking/index.ts.

`settings` (Sept 15 (4)) is a singleton row (day rate, multi-dog
discount, holiday upcharge, vet clinic list) - the admin-configurable
values calcCost and the vet dropdown actually use, replacing hardcoded
constants. Reads are public/unauthenticated (every visitor needs current
pricing and the vet list to use the booking form at all); writes need the
admin password - both go through supabase/functions/settings/index.ts,
same RLS-locked-with-zero-policies pattern as everything else.

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
- src/App.test.js — 105 passing tests (TDD), Supabase mocked via src/__mocks__/supabase.js
- supabase/functions/settings/index.ts — public read / password-gated write of day rate, multi-dog discount, holiday upcharge, vet list
- supabase/functions/submit-booking/index.ts — handles booking submission: find-or-create owner (by phone) and each dog (by owner+name), inserts the stay + stay_dogs snapshot links (service role key)
- supabase/functions/send-confirmation/index.ts — Twilio SMS function (outbound)
- supabase/functions/receive-sms/index.ts — inbound SMS webhook: auto-reply + relay to Kim/Estee. Deploy with `--no-verify-jwt` (see comment at top of file) or Twilio's webhook calls silently fail
- supabase/functions/_shared/contact.ts — pure text builders + Twilio signature validator, shared by send-confirmation and receive-sms, unit-tested via `deno test`
- supabase/functions/admin-data/index.ts — server-side admin password check + every dog (profile + owner + stay history) (service role key, never exposed to client)
- supabase/functions/lookup-client/index.ts — returning-client autofill by phone: vet + every dog on file (returns only safe fields, never aggression/health)
- supabase/migrations/ — schema history, including the Sept 14 dog-profiles reorg (owners/dogs/stays/stay_dogs) and the RLS lockdown history for the old flat `stays` table
- FIXES.txt — current fix list and backlog

## Security notes
- This is a static, client-side-only app (GitHub Pages, no server) — anything
  in the JS bundle is public. Never put secrets (passwords, API keys) directly
  in App.js/settings.js again; they must live server-side as Supabase secrets
  and be checked from an Edge Function.
- `owners`, `dogs`, `stays`, `stay_dogs`, `settings` are all RLS-locked
  with zero policies — no anon or authenticated access at all, reads and
  writes alike. Admin reads go through admin-data, returning-client
  lookup through lookup-client, booking submission through
  submit-booking, and pricing/vet-list reads and writes through
  settings — all four Edge Functions use the service role key
  server-side. Do not add a public policy on any of these tables without
  a real reason — the first four hold client PII (names, phone, email,
  signatures, health/aggression notes); `settings` isn't sensitive but
  writes still need the admin password, checked in the function.

## Current priorities (v1.5)
1. Stay reminder SMS — cron job 24hrs before drop-off
2. Billing SMS — admin triggers from stay detail view

## Rules
- Always run tests before committing (npm test -- --watchAll=false)
- Non-business-rule config (business info, SMS templates, packing list)
  goes in src/settings.js. Business rules an admin should be able to
  change (day rate, multi-dog discount, holiday upcharge, vet list) live
  in Supabase's `settings` table instead (see Data model) - settings.js
  still holds the fallback defaults for those, used before the fetch
  resolves or if it fails, but is not the source of truth for them.
- Follow TDD — write tests before new features
- Commit messages use format: "v1.x - description"
