# Bayview Boarding — Project Brief for Claude

## What this is
A React web app for Bayview Boarding, a home-based dog boarding business run by 
Kim Miller and Estee Fletter at 210 Bayview Drive, San Rafael, CA.

## What it does
- Client intake form, a fixed 4 steps: owner info (name/phone/email/vet
  + a dog list), stay dates, waiver, signature. Vet is asked once on the
  owner page, not per dog (Sept 14 reorg, moved off the dog page Sept
  15). The owner page's dog list (replacing the old "Number of Dogs"
  number input Sept 17, 2026) shows each dog by name (falling back to
  "Dog N" while unnamed), with "Edit" (opens that dog's own full-profile
  page — breed/DOB/spay-neuter/aggression/health — inline, in place of
  the owner page, ending with "Done"/"← Back to Dogs") and "Delete"
  buttons, plus "+ Add Dog" (as many as you like, opens the new dog's
  page directly). Any dog failing dogIsComplete() shows a red "Needs
  updating" label next to its name (Sept 18, 2026) - previously the only
  sign was Continue staying disabled with no visible reason why, which
  especially mattered right after a returning-client lookup autofill
  (fills name/breed/DOB/spay-neuter but never aggression/health).
  Continue only enables once every listed dog passes its own
  required-field check, then goes straight to Stay Dates - dog pages
  are edited in place from this list rather than forced sequential
  top-level wizard steps (Sept 17, 2026 (4) reorg)
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
  see supabase/functions/send-reminders), pickup reminders (the same
  idea for the day before check_out instead of check_in, Sept 17 - see
  supabase/functions/send-pickup-reminders), and billing texts (admin-
  triggered, editable final cost, not auto-sent — the estimate can be
  wrong by pickup). A2P 10DLC is APPROVED (confirmed via the API Sept
  16, 2026) - real sends actually go through. Every dollar amount is a
  whole dollar with commas, rounded up at exactly .50 ("$1,796", not
  "$1795.5" - formatDollars()). "Reply STOP to opt out." sits below the
  "— Kim & Estee" signature line (with a blank line before it) in EVERY
  outbound client text (Sept 19, 2026 - confirmation and pickup-reminder
  used to have no STOP line or signature at all; now all four match).
  The billing text (Sept 19, 2026) opens with "Thank you for visiting
  Bayview Boarding with {dogName}. Here's your billing detail:" instead
  of "{dogName} is/are ready for pickup" (the old framing read oddly for
  a days-later resend), followed by the actual line-item math - not just
  the final total - via a new {billingBreakdown} placeholder
  (formatCostBreakdownText in App.js, the plain-text twin of the
  on-screen CostBreakdown component). The drop-off reminder's packing
  list is one "• item" bullet per line, not a comma-separated sentence.
  Kim and Estee also get a text copy of every client-facing message sent
  (confirmation/reminder/billing/pickup), identifying who it went to
  (Sept 18, 2026, notifyOwnersOfClientText) - best-effort and awaited,
  never allowed to affect the client send's own success/failure.
  IMPORTANT: the live `settings` table's 4 stored templates have never
  actually been updated since Sept 14, 2026 (confirmed via a read-only
  query Sept 19) - every wording fix above only reaches real texts once
  Kim clicks "Reset to Default" then "Save" for each one in Admin > SMS
  Message Templates (new button, Sept 19); see FIXES.txt NEXT CHANGE
  LIST item 1
- Admin panel, top to bottom (reordered Sept 17 (2)(4), math/grouping
  Sept 18): an "Unbilled Stays" review list — every never-billed stay at
  all, past, in-progress, or future, sorted earliest check-in first
  (previously limited to already-checked-out stays); each card is a
  one-line summary until clicked, which expands it to show the stay's
  details plus "Edit" (reveals correctable dates/times, and Daily
  Rate/Holiday Upcharge % fields defaulting to the site's own settings -
  Recalculate shows the full line-item math, not just the final number:
  nights × rate × dog multiplier (labeled with the actual discount %,
  not just "× N dogs" as if it were a flat multiply - that bare label
  read as a math error once a 2nd-dog discount was actually applied,
  fixed Sept 18, 2026), + holiday-night upcharge if any, = total - see
  calcCostBreakdown) and "Send Billing Text" (works with
  or without opening Edit first - see billed_at below). Below that,
  "Past Stays" — grouped by OWNER now, not by dog (Sept 18, 2026 - an
  owner with 2 dogs used to get 2 rows), scoped to fully billed stays
  only (the direct counterpart to Unbilled Stays; together the two cover
  every signed agreement on file, which is why the old running "{n}
  signed agreements on file" count was deleted rather than kept).
  Opening an owner lists their past stays as the exact same
  click-to-expand card Unbilled Stays uses - a shared multi-dog stay
  shows as one card naming every dog, and "Edit"/"Send Billing Text"
  work identically for a first bill or a correction-and-resend (billStay
  just patches fields and re-stamps billed_at either way). A "Site
  Settings" header (Sept 18, 2026) then separates those two day-to-day
  lookup sections from everything below: a "💡 Ideas & Bugs" section
  (Sept 16 (8) — see feedback below) with an open-count badge and a
  "📢 Testers" section (Sept 17 — see testers below) to maintain a
  tester list and broadcast a personally-greeted SMS to all of them,
  then day rate/discount/holiday/vet-list/packing-list/SMS-template
  settings, both feedback/testers moved to the very bottom of the panel
  (Sept 17 (4)). Each stay card also still offers a "View waiver as
  signed" toggle when that stay has one (Sept 16 (5) — see
  waiver_snapshot below). Reached via the nav menu's "Admin" item (Sept
  16, 2026 — reversed the earlier "no visible entry point" decision on
  request) or the bookmarked ?admin URL; either way it's still fully
  password-gated server-side
- "Learn more about us" page (content from the Bayview Boarding Rover
  profile — bio, home characteristics, photos, all 5-star reviews with
  dates linking out to Rover, an approximate-location map). Reached via
  a real link on the landing page, clicking the "Bayview Boarding" title/
  header, or the nav menu (Sept 16, 2026)
- Hamburger nav menu (every screen): Book a Stay, About Us, Contact Us,
  Submit Idea, Admin (Sept 16, 2026; Book a Stay moved to the top Sept 16 (9))
- "Contact Us" page — relays a name/email-or-phone/message submission to
  Kim & Estee by SMS via send-contact (Sept 16, 2026)
- "Submit Idea" page (Sept 16 (8), simplified (9)) — one open message box
  (name required, invites listing as many things as you like in it -
  deliberately no Type/category picker, which just confused a long list),
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

`stays.reminder_sent_at` (Sept 16, 2026) marks a stay's drop-off reminder
text as already sent, so the daily cron job can't double-text someone on
a retried or overlapping run. `stays.pickup_reminder_sent_at` (Sept 17,
2026) is the same idea for the pickup-side reminder (see send-pickup-
reminders below) - a separate column since it's a separate cron/message.

`stays.billed_at` (Sept 17, 2026) marks a stay as billed - previously
nothing at all tracked whether a bill had been sent, so "which stays
still need billing" wasn't something the app could actually answer. Set
by admin-data's billStay action (see Rules/Key files) only once the
billing SMS has actually been sent successfully, never just on admin
clicking a button.

`stays.waiver_snapshot` (Sept 16 (5), jsonb) captures the exact
WAIVER_SECTIONS content (array of {title, body}) as shown and signed at
submission time - deliberately NOT admin-editable (unlike everything
else in this section): the whole point is that a later edit to
src/waiver.js can never retroactively change what a past client is on
record as having agreed to. submit-booking requires a non-empty array;
admin can view it per-stay via a collapsed-by-default toggle.

`feedback` (Sept 16 (8), form simplified (9)) is the "Submit Idea" queue -
one row per tester submission (name required, contact optional, message,
status open|considered|done). `category` (bug|idea|other) still exists as
a column and the Edge Function still accepts/validates it for backward
compatibility, but the form no longer sends it - every row defaults to
"idea" and admin no longer displays it; it's vestigial, not a real
feature. Same RLS-locked-with-zero-policies pattern as everything else;
public submit and password-gated list/status-update both go through
supabase/functions/feedback/index.ts (one function, same "request shape
decides the branch" style as settings). A public submit now also texts
both Kim and Estee immediately (Sept 19, 2026, reversing the earlier
"deliberately not wired to any notification" decision - same Twilio
relay pattern send-contact uses, awaited so it can't be dropped by the
Edge Function's runtime tearing down after the response returns; a
failed text never turns a successful submission into an error). The
admin panel's open-count badge remains the fallback "something's new"
signal, plus a standing habit (see Rules) of checking this queue at the
start of any work session, same as FIXES.txt itself.

`testers` (Sept 17, 2026) is the tester broadcast list - name, phone,
email (optional), active (default true, no toggle in the UI yet - see
supabase/functions/testers/index.ts). Unlike settings/feedback, this one
has NO public branch at all: list/add/remove/notify are all admin-
password-gated (same shape as admin-data), since a phone number is
contact info nobody but Kim should read or add to. "notify" texts each
active tester their own personal "Hi {their first name}, " followed by
the composed message verbatim (buildTesterMessage) - the admin compose
box starts pre-filled with a suggested default (DEFAULT_BROADCAST_MESSAGE
in App.js) that already includes the site link and "Submit Idea"
directions, fully editable before each send and reset back to that
default afterward, rather than a fixed server-side footer (that was the
Sept 17 design, replaced same-day once "Hi {name}," was added - a
server-appended footer would have meant the greeting landed at the very
end of the text instead of the start). Reuses the same Twilio sendSms
pattern as receive-sms/send-confirmation.

**Reproducing the reminder cron's secret** (Sept 16, 2026): the cron job
(supabase/migrations/20260916000000_stay_reminders_cron.sql) calls
send-reminders via pg_net with an x-cron-secret header, read from
`vault.decrypted_secrets where name = 'cron_secret'` - the actual value
is deliberately not in any git-tracked file. send-pickup-reminders (Sept
17, 2026) reuses this exact same secret/vault entry, just a second cron
schedule (send-stay-pickup-reminders-daily, 5 min offset) pointed at a
different function - no separate secret needed. If the cron job or the
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
- src/App.test.js — 181 passing tests (TDD), Supabase mocked via src/__mocks__/supabase.js
- supabase/functions/send-contact/index.ts — public Contact Us form handler: relays name/email-or-phone/message to Kim & Estee by SMS (reuses KIM_PHONE/ESTEE_PHONE). Deployed normally (no --no-verify-jwt) since it's called via the Supabase JS client like settings/lookup-client/submit-booking
- supabase/functions/feedback/index.ts — "Submit Idea": public submit (no password, also texts Kim & Estee - Sept 19, 2026) + admin list/status-update (password) for the feedback queue
- supabase/functions/testers/index.ts — tester broadcast list: entirely admin-password-gated list/add/remove/notify (no public branch at all); notify greets each active tester by their own first name
- supabase/functions/send-pickup-reminders/index.ts — daily cron target, the pickup-side counterpart to send-reminders: finds stays checking out tomorrow, texts each via send-confirmation (type "pickup"), marks pickup_reminder_sent_at. Deployed with `--no-verify-jwt` - same care needed on redeploy as send-reminders
- public/img/about/ — the 6 numbered photos on the About page, served from the public folder (not bundled) and referenced via process.env.PUBLIC_URL since the app is hosted at a subpath
- supabase/functions/send-reminders/index.ts — daily cron target (pg_cron + pg_net, see the migration): finds stays checking in tomorrow, fetches the current sms_reminder template + packing_list from `settings`, texts each via send-confirmation, marks reminder_sent_at. Deployed with `--no-verify-jwt`; checks its own CRON_SECRET instead (see Data model for how that secret is set up without ever being committed) - be careful to keep that flag on every redeploy (a plain `supabase functions deploy send-reminders` silently re-enables JWT verification and would break the cron, same bug class as the receive-sms incident)
- supabase/functions/settings/index.ts — public read / password-gated write of day rate, multi-dog discount, holiday upcharge, vet list, packing list, and the 4 SMS templates (confirmation/drop-off reminder/pickup reminder/billing)
- supabase/functions/submit-booking/index.ts — handles booking submission: find-or-create owner (by phone) and each dog (by owner+name), inserts the stay (incl. waiver_snapshot) + stay_dogs snapshot links (service role key)
- supabase/functions/send-confirmation/index.ts — Twilio SMS function (outbound); accepts an optional message_template (the admin-edited settings text, with {placeholders} filled by fillTemplate, including {dogVerb} - "is"/"are" - and {billingBreakdown} - the full cost math, Sept 19, 2026) + packing_list from the caller; falls back to its own hardcoded 4-message-type logic (confirmation/reminder/billing/pickup) if no template is given. Every dollar placeholder ({finalCost}/{estimatedCost}) is run through formatDollars() first (whole dollars, comma-separated). Also texts Kim/Estee a copy of every client send (notifyOwnersOfClientText, Sept 18, 2026). Called directly by the client at booking time, and by send-reminders/send-pickup-reminders/the admin panel for the other three - has its own Deno test suite (index.test.ts), added Sept 16 (5)
- supabase/functions/receive-sms/index.ts — inbound SMS webhook: auto-reply + relay to Kim/Estee. Deploy with `--no-verify-jwt` (see comment at top of file) or Twilio's webhook calls silently fail
- supabase/functions/_shared/contact.ts — pure text builders + Twilio signature validator, shared by send-confirmation and receive-sms, unit-tested via `deno test`
- supabase/functions/admin-data/index.ts — server-side admin password check + every dog (profile + owner + stay history) (service role key, never exposed to client). Also handles billStay (Sept 17, 2026): saves corrected check-in/out/drop/pickup/cost and marks billed_at, returning the refreshed dog list
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
See FIXES.txt for the live list. As of Sept 19, 2026 the top item is
action Kim needs to take, not code: the live `settings` table's 4 SMS
templates have never been re-saved since Sept 14, so every wording fix
since then (this session's included) has had no effect on real texts -
Kim needs to click "Reset to Default" then "Save" for each one in
Admin > SMS Message Templates. Beyond that, FIXES.txt's own backlog
(confirming the debug Twilio API key is actually deleted, and setting
up a staging environment next time a DB/RLS change is made against
production).

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
- At the start of any work session here, check the "Submit Idea" queue
  (admin panel > 💡 Ideas & Bugs) for open tester feedback, same habit as
  checking FIXES.txt itself (Sept 16, 2026) - it's the mechanism Kim
  built specifically so feedback doesn't need SMS/email to reach him.
  Act on anything worth doing, moving it to Considered/Done from the
  admin list; promote genuinely actionable items into FIXES.txt's NEXT
  CHANGE LIST credited "Suggested by [name]". Recurring, not a
  one-time task.
