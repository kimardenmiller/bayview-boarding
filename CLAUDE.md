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
  uncapped) — all three, plus the vet clinic list, the packing list, and
  the 3 SMS message templates, are loaded from Supabase on every page load
  (public read) and editable in the admin panel (Sept 15 (4), packing
  list/SMS templates added Sept 16 (5) — see Data model below)
- Past check-in dates are rejected, client-side (StepDates) and
  server-side (submit-booking, the actual boundary); a same-day stay's
  pick-up must be after its drop-off (no such constraint across days)
- Twilio SMS: booking confirmations (sent at submission), stay reminders
  (a daily cron job texts everyone checking in the next day, Sept 16 —
  see supabase/functions/send-reminders), and billing texts (admin-
  triggered from the stay detail view with an editable final cost, not
  auto-sent — the estimate can be wrong by pickup). A2P 10DLC is APPROVED
  (confirmed via the API Sept 16, 2026) - real sends actually go through
- Admin panel: browse by dog, each with its always-current profile and full
  stay history (each past stay shows its own frozen declared/signed
  snapshot, not just the dog's latest profile — see Data model below), a
  "Send Billing Text" control and a "View waiver as signed" toggle (Sept
  16 (5) — see waiver_snapshot below) on every stay, plus a "💡 Ideas &
  Bugs" section (Sept 16 (8) — see feedback below) with an open-count
  badge. Reached via the nav menu's "Admin" item (Sept 16, 2026 —
  reversed the earlier "no visible entry point" decision on request) or
  the bookmarked ?admin URL; either way it's still fully password-gated
  server-side
- "Learn more about us" page (content from the Bayview Boarding Rover
  profile — bio, home characteristics, photos, all 5-star reviews with
  dates linking out to Rover, an approximate-location map). Reached via
  a real link on the landing page, clicking the "Bayview Boarding" title/
  header, or the nav menu (Sept 16, 2026)
- Hamburger nav menu (every screen): About Us, Contact Us, Submit Idea,
  Book a Stay, Admin (Sept 16, 2026)
- "Contact Us" page — relays a name/email-or-phone/message submission to
  Kim & Estee by SMS via send-contact (Sept 16, 2026)
- "Submit Idea" page (Sept 16 (8)) — testers report bugs/ideas/feedback,
  persisted (not texted - see feedback below) so it's an actual triage
  queue in admin rather than scrollback in a text thread

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

`settings` (Sept 15 (4); packing_list/sms_confirmation/sms_reminder/
sms_billing added Sept 16 (5)) is a singleton row (day rate, multi-dog
discount, holiday upcharge, vet clinic list, packing list, 3 SMS
templates) - the admin-configurable values calcCost/the vet dropdown/
send-confirmation actually use, replacing hardcoded constants (the SMS
templates and packing list used to be duplicated - once as a "reference
copy" in src/settings.js, once for real inside send-confirmation/
index.ts - and had already started to drift; now there's one source of
truth). Reads are public/unauthenticated (every visitor needs current
pricing and the vet list to use the booking form at all); writes need the
admin password - both go through supabase/functions/settings/index.ts,
same RLS-locked-with-zero-policies pattern as everything else.
Kim/Estee's phone numbers deliberately stay OUT of this table even
though they're conceptually "business info" - settings reads are public,
so putting personal cell numbers there would leak them to every visitor.
They remain KIM_PHONE/ESTEE_PHONE Supabase secrets, changed via
`supabase secrets set` rather than through the admin UI.

`stays.reminder_sent_at` (Sept 16, 2026) marks a stay's reminder text as
already sent, so the daily cron job can't double-text someone on a
retried or overlapping run.

`stays.waiver_snapshot` (Sept 16 (5), jsonb) captures the exact
WAIVER_SECTIONS content (array of {title, body}) as shown and signed at
submission time - deliberately NOT admin-editable (unlike everything
else in this section): the whole point is that a later edit to
src/waiver.js can never retroactively change what a past client is on
record as having agreed to. submit-booking requires a non-empty array;
admin can view it per-stay via a collapsed-by-default toggle.

`feedback` (Sept 16 (8)) is the "Submit Idea" queue - one row per tester
submission (name/contact optional, category bug|idea|other, message,
status open|considered|done). Same RLS-locked-with-zero-policies pattern
as everything else; public submit and password-gated list/status-update
both go through supabase/functions/feedback/index.ts (one function, same
"request shape decides the branch" style as settings). Deliberately not
wired to any notification (SMS costs money; email would need a new
provider account Kim hasn't set up) - the admin panel's open-count badge
is the only "something's new" signal for now.

**Reproducing the reminder cron's secret** (Sept 16, 2026): the cron job
(supabase/migrations/20260916000000_stay_reminders_cron.sql) calls
send-reminders via pg_net with an x-cron-secret header, read from
`vault.decrypted_secrets where name = 'cron_secret'` - the actual value
is deliberately not in any git-tracked file. If the cron job or the
vault secret is ever lost/needs rotating: generate a random value, run
`select vault.create_secret('<value>', 'cron_secret');` directly against
the live database (not saved as a migration), and
`supabase secrets set CRON_SECRET=<same value>` so the Edge Function can
check it. The migration only needs re-running if the cron.schedule()
call itself is dropped, not for a routine secret rotation.

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
- src/App.test.js — 147 passing tests (TDD), Supabase mocked via src/__mocks__/supabase.js
- supabase/functions/send-contact/index.ts — public Contact Us form handler: relays name/email-or-phone/message to Kim & Estee by SMS (reuses KIM_PHONE/ESTEE_PHONE). Deployed normally (no --no-verify-jwt) since it's called via the Supabase JS client like settings/lookup-client/submit-booking
- supabase/functions/feedback/index.ts — "Submit Idea": public submit (no password) + admin list/status-update (password) for the feedback queue
- public/img/about/ — the 6 numbered photos on the About page, served from the public folder (not bundled) and referenced via process.env.PUBLIC_URL since the app is hosted at a subpath
- supabase/functions/send-reminders/index.ts — daily cron target (pg_cron + pg_net, see the migration): finds stays checking in tomorrow, fetches the current sms_reminder template + packing_list from `settings`, texts each via send-confirmation, marks reminder_sent_at. Deployed with `--no-verify-jwt`; checks its own CRON_SECRET instead (see Data model for how that secret is set up without ever being committed) - be careful to keep that flag on every redeploy (a plain `supabase functions deploy send-reminders` silently re-enables JWT verification and would break the cron, same bug class as the receive-sms incident)
- supabase/functions/settings/index.ts — public read / password-gated write of day rate, multi-dog discount, holiday upcharge, vet list, packing list, and the 3 SMS templates
- supabase/functions/submit-booking/index.ts — handles booking submission: find-or-create owner (by phone) and each dog (by owner+name), inserts the stay (incl. waiver_snapshot) + stay_dogs snapshot links (service role key)
- supabase/functions/send-confirmation/index.ts — Twilio SMS function (outbound); accepts an optional message_template (the admin-edited settings text, with {placeholders} filled by fillTemplate) + packing_list from the caller; falls back to its own hardcoded 3-message-type logic if no template is given. Called directly by the client at booking time, and by send-reminders and the admin panel for the other two - has its own Deno test suite (index.test.ts) now, added Sept 16 (5)
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
- Twilio A2P 10DLC is APPROVED (confirmed via the API Sept 16, 2026) -
  real SMS sends now actually go through, unlike earlier in development
  when they silently failed. When testing the live site, use a
  555-01XX phone number (e.g. 415-555-0199) - that block is permanently
  reserved by NANPA across every area code for fictional/testing use and
  can never reach a real subscriber. Prefer read-only checks (Supabase
  dashboard, live settings reads) over writing test records/triggering
  test sends directly against production when diagnosing an issue; if a
  live write genuinely is necessary, clean it up immediately and verify
  the cleanup actually took.

## Current priorities (v1.5)
See FIXES.txt for the live list - nothing outstanding here as of Sept
16, 2026 beyond that file's own items (confirming the debug Twilio API
key is actually deleted, and setting up a staging environment next time
a DB/RLS change is made against production).

## Rules
- Always run tests before committing (npm test -- --watchAll=false)
- Non-business-rule config (business name/address, the Twilio public
  number) goes in src/settings.js. Business rules an admin should be able
  to change (day rate, multi-dog discount, holiday upcharge, vet list,
  packing list, SMS templates) live in Supabase's `settings` table instead
  (see Data model) - settings.js still holds the fallback defaults for
  those, used before the fetch resolves or if it fails, but is not the
  source of truth for them. Exception: Kim/Estee's personal phone numbers
  are business-relevant but stay as Supabase secrets, never in `settings`
  (which is publicly readable) - see the Data model note on why.
- Follow TDD — write tests before new features
- Commit messages use format: "v1.x - description"
