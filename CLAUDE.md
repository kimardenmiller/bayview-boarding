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
- Each dog's page has an optional photo picker (Sept 21, 2026, on
  request - see Data model's dogs.photo_path). Picking a file shows an
  instant local preview and uploads in the background right away, never
  deferred to final submit - never required to advance, whether the
  upload is in flight or fails (a non-blocking message shows instead).
  Visible to admin on the Requests card once submitted, and (since the
  underlying data is shared) on Unbilled Stays/Awaiting Payment/Past
  Stays too.
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
- A submission is a REQUEST now, not an instant booking (Sept 21, 2026,
  on request - see Data model's approval_status). The "Book My Stay"
  button/CTA wording is unchanged; a boxed notice at the top of the
  actual booking page, above "Owner Information" ("You are booking a
  non-binding booking request..." - moved here from the landing page
  the same day, on request) and the rewritten confirmation screen
  ("Request received...") set that expectation instead. Every new stay
  starts approval_status 'pending'; admin
  approves or denies it from the new admin Requests section (see Admin
  panel below), which is what actually sends the real booking
  confirmation text (or a decline) - the client's immediate text at
  submission is a separate, distinct "request received" message.
- Twilio SMS: booking confirmations (sent once admin approves a
  request, not at submission - Sept 21, 2026), stay reminders
  (a daily cron job texts everyone checking in the next day, Sept 16 —
  see supabase/functions/send-reminders), pickup reminders (the same
  idea for the day before check_out instead of check_in, Sept 17 - see
  supabase/functions/send-pickup-reminders), and billing texts (admin-
  triggered, editable final cost, not auto-sent — the estimate can be
  wrong by pickup). A2P 10DLC is APPROVED (confirmed via the API Sept
  16, 2026) - real sends actually go through. Every dollar amount is a
  whole dollar with commas, rounded up at exactly .50 ("$1,796", not
  "$1795.5" - formatDollars()). The billing text opens with "Thank you
  for visiting Bayview Boarding with {dogName}. Here's your billing
  detail:" instead of "{dogName} is/are ready for pickup" (the old
  framing read oddly for a days-later resend), followed by the actual
  line-item math - not just the final total - via {billingBreakdown}
  (formatCostBreakdownText in App.js, the plain-text twin of the
  on-screen CostBreakdown component). The drop-off reminder's packing
  list is one "• item" bullet per line, not a comma-separated sentence.
  Every outbound message ends with a single shared "Text Message
  Footer" ("Reply STOP to opt out...", admin-editable in Admin > SMS
  Message Templates, just below "Placeholders") appended once,
  server-side, by send-confirmation itself (Sept 18, 2026) - not stored
  in each of the 4 templates any more, so it can't drift or duplicate
  across them. Kim and Estee also get a text copy of every client-facing
  message sent, identifying who it went to (notifyOwnersOfClientText) -
  best-effort and awaited, never allowed to affect the client send's own
  success/failure.
- Admin panel, top to bottom (reordered Sept 17 (2)(4), math/grouping
  Sept 18; "Requests" added above everything else Sept 21, 2026): a
  "Requests" section — every pending stay (a submission admin hasn't
  approved or denied yet), sorted earliest check-in first; each card
  expands to show the request's details (view-only - no Edit/billing
  fields, since it isn't a real booking yet) plus "Approve" (sends the
  real booking confirmation text, then marks it approved) and "Deny"
  (an optional typed reason, folded into a decline text sent before the
  stay is marked denied - same "text first, then persist" ordering as
  billing below). Then an "Unbilled Stays" review list — every approved-
  but-never-billed stay, past, in-progress, or future, sorted earliest
  check-in first (previously limited to already-checked-out stays); each
  card is a
  one-line summary until clicked, which expands it to show the stay's
  details plus "Edit" (reveals correctable dates/times, and Daily
  Rate/Holiday Upcharge % fields defaulting to the site's own settings -
  Recalculate shows the full line-item math, not just the final number:
  nights × rate × dog multiplier (labeled with the actual discount %,
  not just "× N dogs" as if it were a flat multiply - that bare label
  read as a math error once a 2nd-dog discount was actually applied,
  fixed Sept 18, 2026), + holiday-night upcharge if any, = total - see
  calcCostBreakdown) and "Send Billing Text" (works with
  or without opening Edit first - see billed_at below). Then "Awaiting
  Payment" (Sept 21, 2026, on request) — every billed-but-not-yet-paid
  stay, same card/Edit/Send Billing Text as Unbilled Stays (in case the
  billed amount needs correcting before payment comes in), plus a new
  "Mark Paid" button — unlike billStay/approveStay/denyStay, this isn't
  tied to any text send first, it's just admin recording that payment
  actually arrived. Below that, "Past Stays" — grouped by OWNER now, not
  by dog (Sept 18, 2026 - an owner with 2 dogs used to get 2 rows),
  scoped to fully billed AND PAID stays PLUS denied requests, both shown
  view-only (Sept 21, 2026): a paid stay shows "Paid" and a denied one
  shows "Rejected" (with its typed reason, if one was given) - neither
  has Edit/Send Billing Text any more, since both are closed records now
  (previously a denied request just vanished from admin entirely once
  decided, and a billed stay stayed editable/re-billable forever).
  Opening an owner lists their past stays as the exact same
  click-to-expand card Unbilled Stays/Awaiting Payment use (each card
  has an explicit "View"/"Hide" button - Sept 21, 2026 - previously the
  whole row was clickable with no visible sign of it) - a shared
  multi-dog stay shows as one card naming every dog. A "Site
  Settings" header (Sept 18, 2026) then separates those day-to-day
  lookup sections (Requests/Unbilled Stays/Awaiting Payment/Past Stays)
  from everything below: a "💡 Ideas & Bugs" section
  (Sept 16 (8) — see feedback below) with an open-count badge, each
  submission's status buttons now also including a permanent "Delete"
  (Sept 18, 2026, no confirmation step - same pattern as testers'
  "remove" below) alongside them, and a
  "📢 Testers" section (Sept 17 — see testers below) to maintain a
  tester list and broadcast a personally-greeted SMS to all of them,
  then day rate/discount/holiday/vet-list/packing-list/about-photos/
  SMS-template settings (the packing list's items are editable in place
  and reorderable via Up/Down buttons, not just add/remove - Sept 19,
  2026; "About Photos" - Sept 21, 2026 - is the same idea plus a
  thumbnail and a file picker to upload a new one: Up/Down + alt-text
  edits stay local until "Save Photo Order", but Upload/Remove are each
  immediate - they touch real Supabase Storage files, not just this
  list, so leaving one half-done behind an unclicked Save risked
  orphaned files; the SMS Message Templates section now also holds the Text
  Message Footer editor and a "Manager 1/2 Phone" editor - relabeled
  Sept 19, 2026 from "Primary/Secondary Manager Phone" - for
  {primaryManagerPhone}/{secondaryManagerPhone} - renamed Sept 18, 2026
  from {kimPhone}/{esteePhone} - directly below it, both admin-only:
  see Data model's `settings` entry), both feedback/testers moved to the
  very bottom of the panel (Sept 17 (4)). Each stay card also still
  offers a "View waiver as signed" toggle when that stay has one (Sept
  16 (5) — see
  waiver_snapshot below). Reached via the nav menu's "Admin" item (Sept
  16, 2026 — reversed the earlier "no visible entry point" decision on
  request) or the bookmarked ?admin URL; either way it's still fully
  password-gated server-side
- An "About Us" section (content from the Bayview Boarding Rover
  profile — bio, home characteristics, photos, all 5-star reviews with
  dates linking out to Rover, an approximate-location map) lives directly
  on the landing page below the hero, not a separate page (merged Sept
  19, 2026 - Suggested by JK via Submit Idea: having to click through to
  read about them first, before ever seeing the booking button, was
  extra friction). The landing hero's "Learn more →" and the nav menu's
  "About Us" both scroll smoothly down to it (aboutSectionRef in App.js);
  from mid-booking, clicking the "Bayview Boarding" header wordmark
  returns to the landing page and then scrolls down to it the same way.
  Its photo gallery is admin-manageable now (Sept 21, 2026 - see Data
  model's settings.about_photos and Admin panel below), not a hardcoded
  array - the actual image files live in Supabase Storage instead of
  the git-tracked public/ folder.
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
sms_billing added Sept 16 (5); sms_footer/primary_manager_phone/
secondary_manager_phone added Sept 18, 2026; default_broadcast_message
added Sept 19, 2026; sms_request_received/sms_denied/about_photos added
Sept 21, 2026) is a singleton row (day rate, multi-dog discount, holiday
upcharge, vet clinic list, packing list, the About page's photo list,
6 SMS templates, the shared footer, 2 manager phone numbers, the tester
broadcast's saved default message) - the admin-configurable values
calcCost/the vet dropdown/send-confirmation actually use, replacing
hardcoded constants (the SMS templates and packing list used to be
duplicated - once as a "reference copy" in src/settings.js, once for
real inside send-confirmation/index.ts - and had already started to
drift; now there's one source of truth). about_photos is a jsonb array
of `{path, alt}` - `path` is a file's location within the "about-photos"
Storage bucket, not the file itself (see Key files' about-photos entry
for uploads/deletes, which go through Storage directly, not this
column); App.js's `aboutPhotoSrc` resolves a path to an actual URL via
`supabase.storage.from('about-photos').getPublicUrl(path)`, a pure
string-construction call, not a network request. Unlike vets/
packing_list, an empty about_photos list is a legitimate state (no
non-empty-list validation on it in settings/index.ts). supabase/
functions/settings/index.ts splits its own column list in two:
PUBLIC_COLUMNS (everything above except the phone numbers and the
broadcast default) is what a plain, unauthenticated read returns -
every visitor needs current pricing/vet-list/templates/photos
(sms_request_received/sms_denied/about_photos included - the client's
own browser builds the request-received/denial texts same as the other
4, and needs the current photo list to render the About page at all) to
use the booking form and complete their own SMS sends; ADMIN_COLUMNS
(PUBLIC_COLUMNS + the phone numbers + default_broadcast_message) is
returned only when
the request carries the correct admin password, whether that's a write
(`updates` present) or a dedicated password-only read with no `updates`
(new Sept 18, 2026 - this is what lets Admin populate the 2 manager-
phone edit fields without a public read ever seeing them). Kim/Estee's
phone numbers used to stay
completely out of this table for exactly that "public read must never
leak a personal cell number" reason (they lived only as the
KIM_PHONE/ESTEE_PHONE Supabase secrets) - Sept 18, 2026 moved them into
`settings` anyway, now that the column-selection split above enforces
the same guarantee at the Edge Function level instead of by keeping the
data out of the database entirely; this was needed to make them
admin-editable via the UI at all (an Edge Function has no way to call
`supabase secrets set` on its own). send-confirmation still needs its
own direct DB read for these (it has no other way to get an
admin-authenticated response), which is also where it gets sms_footer
- see Key files. KIM_PHONE/ESTEE_PHONE secrets still exist and are
still used by receive-sms/send-contact/testers/feedback (out of scope
for the Sept 18 change - only send-confirmation's usage moved to the
new DB columns).

`stays.approval_status` (Sept 21, 2026 - 'pending'/'approved'/'denied',
default 'pending') is the new booking request/approval workflow (see
Rules for the standing habit that surfaced this as a Submit Idea
suggestion from Estee). Every stay that existed before this column was
added was backfilled to 'approved' (approved_at set to its original
submitted_at) - only genuinely new submissions start 'pending'.
`stays.approved_at`/`stays.denied_at` stamp when admin actually decided
(admin-data's approveStay/denyStay actions - see Key files), and
`stays.denial_reason` is admin's own optional typed-in explanation,
folded into the decline text via send-confirmation's {denialReason}
placeholder. Unbilled Stays/Past Stays both filter to
`approval_status = 'approved'` now - a pending or denied stay was never
a real booking, so it never shows up in either.

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

`stays.paid_at` (Sept 21, 2026) is the same idea one step further -
"billed" never answered "has this actually been paid?" Set by
admin-data's markPaid action once admin confirms payment actually
arrived - unlike billStay/approveStay/denyStay, this one isn't preceded
by any text send (there's no client-facing message to confirm went out
first, just a status admin is recording). A billed-but-unpaid stay
shows in the admin "Awaiting Payment" section; once paid_at is set, it
moves to Past Stays as a closed, view-only record showing "Paid". Every
stay already billed before this column existed was backfilled to paid
(paid_at = billed_at) - same reasoning as the approval_status backfill
above.

`dogs.photo_path`/`stay_dogs.photo_path` (Sept 21, 2026, nullable) let an
owner upload a photo of their dog during booking - `dogs.photo_path` is
the current/always-up-to-date profile photo (same role as breed/DOB/
spay-neuter there), `stay_dogs.photo_path` is the frozen per-stay
snapshot, same reasoning as every other stay_dogs snapshot column. The
Storage bucket ("dog-photos") is PRIVATE, unlike "about-photos" above -
a client's own dog photo is their data, not public marketing content -
so admin views it via a signed URL resolved server-side in admin-data
(1-hour TTL, re-signed fresh on every fetch) rather than a public
bucket URL. The owner's upload itself goes through a dedicated public/
unauthenticated Edge Function (dog-photos, upload only, no delete) -
same trust boundary as submit-booking/feedback's own public writes,
since a first-time visitor has no password. See Key files.

`stays.waiver_snapshot` (Sept 16 (5), jsonb) captures the exact
WAIVER_SECTIONS content (array of {title, body}) as shown and signed at
submission time - deliberately NOT admin-editable (unlike everything
else in this section): the whole point is that a later edit to
src/waiver.js can never retroactively change what a past client is on
record as having agreed to. submit-booking requires a non-empty array;
admin can view it per-stay via a collapsed-by-default toggle.

`feedback` (Sept 16 (8), form simplified (9)) is the "Submit Idea" queue -
one row per tester submission (name required, contact optional, message,
status open|on_list|done|rejected - `on_list`/`rejected` renamed/added
Sept 18, 2026, replacing `considered`: "On List" once a submission is
promoted into FIXES.txt's NEXT CHANGE LIST, "Rejected" if decided
against; all 4 are still set manually, one click each, from Admin >
Ideas & Bugs). `category` (bug|idea|other) still exists as
a column and the Edge Function still accepts/validates it for backward
compatibility, but the form no longer sends it - every row defaults to
"idea" and admin no longer displays it; it's vestigial, not a real
feature. Same RLS-locked-with-zero-policies pattern as everything else;
public submit and password-gated list/status-update/delete (permanent,
no confirmation step - Sept 18, 2026, action: 'delete' alongside id in
the request body, distinguishing it from a status update) all go
through supabase/functions/feedback/index.ts (one function, same
"request shape decides the branch" style as settings). A public submit
now also texts
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
box starts pre-filled with a saved default (settings.default_broadcast_
message, admin-only column, editable via a "Save as Default" button next
to Send - added Sept 19, 2026; DEFAULT_BROADCAST_MESSAGE in App.js is
now only the fallback used before that admin-authenticated fetch
resolves) that includes the staging site link and "Submit Idea"
directions, fully editable before each send and reset back to the saved
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
- Twilio auth (Sept 21, 2026): every function that sends an outbound SMS (send-confirmation, send-contact, testers, feedback, receive-sms's own reply) authenticates with `TWILIO_API_KEY_SID`/`TWILIO_API_KEY_SECRET` if set, falling back to `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` otherwise — a restricted, independently-revocable API key is Twilio's own recommendation over the Auth Token (full, unscoped account access). Production has the API key set; the fallback exists for a genuine Twilio "Test Credentials" pair, which has no API-key equivalent - staging ended up with neither (see Staging environment below for why), so it currently has no Twilio credentials at all and its outbound sends just fail. `TWILIO_ACCOUNT_SID` is always required on whichever environment does have credentials (every request URL needs the real Account SID regardless of which credential authenticates it), and `TWILIO_AUTH_TOKEN` stays in use by receive-sms specifically for Twilio's webhook signature check, which only works with the real Auth Token — never an API key.

## Staging environment (Sept 19, 2026)
Same repo, no second codebase: a `staging` git branch (currently
identical to main - meant as the home for future DB-schema/RLS-risky
work, verified live via a staging deploy before merging to main) and a
second Supabase project ("Boarding Staging", ref uqmjudozfqlmiepnqodx,
same org/region as production) deployed to
kimardenmiller.github.io/bayview-boarding/staging/ - a `staging/`
subfolder of the same gh-pages branch production deploys to the root of.
`npm run build:staging` overrides `PUBLIC_URL` plus
`REACT_APP_SUPABASE_URL`/`REACT_APP_SUPABASE_KEY` (read by src/
supabase.js, falling back to production's own public values when unset)
so the build talks to the staging project instead; `npm run
deploy:staging` builds then runs `gh-pages -d build --dest staging`.
Both this and the plain `deploy` script now pass `--add` - gh-pages
otherwise removes any file in the WHOLE target branch not part of the
current publish, which would make each deploy wipe the other's, now
that they share one branch (occasional manual cleanup of old content-
hashed JS/CSS files may eventually be worth doing, since `--add` means
they're never automatically removed).

Staging's schema was bootstrapped directly from every migration from
the Sept 14 dog-profiles reorg onward (skipping the stays_legacy
rename+backfill and both cron.schedule() calls, which only make sense
against real historical data / a real deployed cron target) rather than
replayed from the very first migration - the two earliest migrations in
supabase/migrations/ both assume a `stays` table that predates this
project's migration-file history (created via the Dashboard UI before
that workflow was adopted), so a from-scratch replay was never actually
possible. Staging has no cron jobs scheduled (send-reminders/send-
pickup-reminders are deployed and manually callable, just not on a
daily schedule - testers exercise the booking flow directly) and no
Twilio credentials at all, by decision (Sept 21, 2026) rather than an
open item - Twilio retired creating new Test Credentials (existing ones
from before that console migration still work, but there's no way to
generate a fresh pair), and a Subaccount (the real alternative - its
own isolated Account SID/Auth Token) would need its own paid phone
number, since a number can't be shared across accounts. Not worth it:
the booking flow and everything else on staging works fully either way,
only the confirmation/notification texts silently don't send.

## SEO & Analytics (Sept 19, 2026)
Google Analytics 4 (gtag.js, Measurement ID G-160YK5FB7D - Kim's own
"Bayview Boarding" GA account, separate from his unrelated "Manifest"
one) is wired up in src/index.js, gated on `process.env.PUBLIC_URL`
containing "/staging" - fires only on production, so tester/staging
traffic never pollutes real analytics; staging gets a runtime-injected
`<meta name="robots" content="noindex, nofollow">` instead (same file,
same gating check), keeping it out of search results entirely. This
lives in JS rather than a static `<script>` in public/index.html
because that file is a single template shared by both the production
and staging builds, with no way to leave a tag out on its own.

Standard on-page SEO otherwise: a real meta description, Open Graph/
Twitter card tags, a self-referencing canonical URL (all in public/
index.html, using %PUBLIC_URL% so each build points at itself), and
public/sitemap.xml - necessarily just the one URL, since this is a
client-side SPA with no server-side routing and so no other distinct
crawlable paths exist. The link-preview image (og:image/twitter:image,
Sept 21, 2026) is the landing hero photo - public/img/hero-dog.jpg, a
copy of src/img/hero-dog.jpg kept in sync manually (the JS-imported
original gets a webpack content hash on every build, so it has no
stable URL a static meta tag could reference). Every %PUBLIC_URL%-based
URL (canonical/og:url/og:image, plus every image src that uses
process.env.PUBLIC_URL, like the About page gallery) resolves to a full
https:// URL, not a relative path - package.json's `build` script
passes an explicit absolute PUBLIC_URL for exactly this (Sept 21, 2026;
build:staging already did), since Open Graph requires absolute URLs and
a relative one isn't reliably honored by every platform. public/
robots.txt lives at a path GitHub Pages crawlers never actually check
(robots.txt is only honored at the true domain root,
kimardenmiller.github.io/robots.txt, and this site is at a subpath of
that shared domain, not a custom domain) - kept anyway for
convention and its Sitemap: reference, submittable to Search Console
directly regardless. This is a client-side-only SPA with no
server-side rendering, so a crawler that doesn't execute JS still sees
only an empty shell - true SEO here is inherently limited by that, not
something this pass changes.

## Key files
- src/App.js — main app
- src/settings.js — all configurable values (rates, vets, messages, packing list)
- src/waiver.js — full waiver text
- src/App.test.js — 219 passing tests (TDD), Supabase mocked via src/__mocks__/supabase.js
- src/supabase.js — creates the Supabase client from REACT_APP_SUPABASE_URL/_KEY (falling back to production's own public values) - see Staging environment above for how the staging build overrides these
- src/index.js — app entry point; also where Google Analytics loads (production only) and staging's noindex meta tag gets injected - see SEO & Analytics above
- supabase/functions/send-contact/index.ts — public Contact Us form handler: relays name/email-or-phone/message to Kim & Estee by SMS (reuses KIM_PHONE/ESTEE_PHONE). Deployed normally (no --no-verify-jwt) since it's called via the Supabase JS client like settings/lookup-client/submit-booking
- supabase/functions/feedback/index.ts — "Submit Idea": public submit (no password, also texts Kim & Estee) + admin list/status-update/delete (password) for the feedback queue
- supabase/functions/testers/index.ts — tester broadcast list: entirely admin-password-gated list/add/remove/notify (no public branch at all); notify greets each active tester by their own first name
- supabase/functions/send-pickup-reminders/index.ts — daily cron target, the pickup-side counterpart to send-reminders: finds stays checking out tomorrow, texts each via send-confirmation (type "pickup"), marks pickup_reminder_sent_at. Deployed with `--no-verify-jwt` - same care needed on redeploy as send-reminders
- public/img/about/ — the 6 numbered photos on the About page, served from the public folder (not bundled) and referenced via process.env.PUBLIC_URL since the app is hosted at a subpath
- supabase/functions/send-reminders/index.ts — daily cron target (pg_cron + pg_net, see the migration): finds stays checking in tomorrow, fetches the current sms_reminder template + packing_list from `settings`, texts each via send-confirmation, marks reminder_sent_at. Deployed with `--no-verify-jwt`; checks its own CRON_SECRET instead (see Data model for how that secret is set up without ever being committed) - be careful to keep that flag on every redeploy (a plain `supabase functions deploy send-reminders` silently re-enables JWT verification and would break the cron, same bug class as the receive-sms incident)
- supabase/functions/settings/index.ts — public read (PUBLIC_COLUMNS) / password-gated read or write (ADMIN_COLUMNS) of day rate, multi-dog discount, holiday upcharge, vet list, packing list, the About page's photo list (about_photos - Sept 21, 2026, just `{path, alt}` pairs; the actual files live in Storage, see about-photos below), the 6 SMS templates (confirmation/drop-off reminder/pickup reminder/billing/request-received/denied - the last 2 added Sept 21, 2026), the shared sms_footer, and (admin-only) the 2 manager phone numbers plus the tester broadcast's default_broadcast_message
- supabase/functions/about-photos/index.ts — manages the actual image files behind settings.about_photos (Sept 21, 2026); entirely admin-password-gated, 2 actions: upload (multipart/form-data: password, file, alt? - stores the file in the "about-photos" Storage bucket under a fresh random name, never the client's own filename, and appends {path, alt} to settings.about_photos) and delete (JSON: password, action 'delete', path - removes the file from Storage AND drops that entry from settings.about_photos in the same call). Reordering/alt-text edits for existing photos don't touch this function at all - they're just settings.about_photos array edits, saved through the settings function like everything else there
- supabase/functions/submit-booking/index.ts — handles booking submission: find-or-create owner (by phone) and each dog (by owner+name), inserts the stay (incl. waiver_snapshot, approval_status 'pending' - Sept 21, 2026) + stay_dogs snapshot links (service role key). Each dog's optional photoPath (Sept 21, 2026, from the dog-photos function's own upload response) is saved to dogs.photo_path ONLY when a new one is given - a returning dog's existing photo is never silently cleared - and snapshotted onto stay_dogs.photo_path either way (falling back to whatever's currently on the dog's profile if no new photo came with this submission)
- supabase/functions/dog-photos/index.ts — lets an owner upload a photo of their dog during booking (Sept 21, 2026); public/unauthenticated (no password - a first-time visitor has none yet), same trust boundary as submit-booking/feedback's own public writes. One action: upload (multipart/form-data: file) - stores it in the private "dog-photos" Storage bucket under a fresh random name, never the client's own filename, and returns {path}, which the client then includes as photoPath on that dog in the submit-booking payload. No delete action (out of scope this round, see FIXES.txt)
- supabase/functions/send-confirmation/index.ts — Twilio SMS function (outbound); accepts an optional message_template (the admin-edited settings text, with {placeholders} filled by fillTemplate, including {dogVerb} - "is"/"are" - {billingBreakdown} - the full cost math - and {denialReason} - Sept 21, 2026, resolves to "" when no reason was given, never a literal unfilled placeholder) + packing_list from the caller; falls back to its own hardcoded 6-message-type logic (confirmation/reminder/billing/pickup/request_received/denied) if no template is given. Every dollar placeholder ({finalCost}/{estimatedCost}) is run through formatDollars() first (whole dollars, comma-separated). Has its own direct DB read (service role, fetchFooterAndPhones) for sms_footer and the 2 manager phone numbers (Sept 18, 2026) - fills {primaryManagerPhone}/{secondaryManagerPhone} and appends the filled footer once to every message, and uses the same numbers as the destination for the Kim/Estee copy of every client send (notifyOwnersOfClientText). Called directly by the client at booking time (type request_received - Sept 21, 2026), and by send-reminders/send-pickup-reminders/the admin panel (confirmation on approve, denied on deny, billing, pickup) - has its own Deno test suite (index.test.ts), added Sept 16 (5)
- supabase/functions/receive-sms/index.ts — inbound SMS webhook: auto-reply + relay to Kim/Estee. Deploy with `--no-verify-jwt` (see comment at top of file) or Twilio's webhook calls silently fail
- supabase/functions/_shared/contact.ts — pure text builders + Twilio signature validator, shared by send-confirmation and receive-sms, unit-tested via `deno test`
- supabase/functions/admin-data/index.ts — server-side admin password check + every dog (profile + owner + stay history, incl. approval_status/approved_at/denied_at/denial_reason/paid_at - Sept 21, 2026) (service role key, never exposed to client). Also handles billStay (Sept 17, 2026): saves corrected check-in/out/drop/pickup/cost and marks billed_at; approveStay/denyStay (Sept 21, 2026): mark a stay approved or denied (denyStay also saves an optional trimmed denial_reason) - both patch the DB and return the refreshed dog list, the actual SMS send is always a separate client-side send-confirmation call first (App.js), same "text actually went out" ordering as billStay; markPaid (Sept 21, 2026): just sets paid_at, no text send involved at all - there's no client-facing message this action is confirming went out. Every stay's photo_path (if any) is also resolved to a signed photoUrl (Sept 21, 2026) before the response goes out, since the "dog-photos" bucket is private - a raw path alone isn't viewable; every distinct path is batch-signed once per fetch (1-hour TTL), and every stay always gets an explicit photoUrl (null when there's no photo), never left undefined
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
See FIXES.txt for the live list. As of Sept 21, 2026 (7) there's nothing
outstanding beyond that file's own standing habit (check the Submit
Idea queue). Staging deliberately has no Twilio credentials and stays
that way - see Staging environment above for why (Twilio retired
creating new Test Credentials, and a Subaccount would need its own paid
phone number) - the booking flow and everything else there still works
fully; only outbound texts silently don't send from staging.

## Rules
- Always run tests before committing (npm test -- --watchAll=false)
- Non-business-rule config (business name/address, the Twilio public
  number) goes in src/settings.js. Business rules an admin should be able
  to change (day rate, multi-dog discount, holiday upcharge, vet list,
  packing list, SMS templates) live in Supabase's `settings` table instead
  (see Data model) - settings.js still holds the fallback defaults for
  those, used before the fetch resolves or if it fails, but is not the
  source of truth for them. Kim/Estee's manager phone numbers now live
  in `settings` too (Sept 18, 2026), but on the ADMIN_COLUMNS-only side
  of that table's public/admin column split (see Data model) - never
  returned by a public read, unlike everything else in this bullet.
- Follow TDD — write tests before new features
- Commit messages use format: "v1.x - description"
- At the start of any work session here, check the "Submit Idea" queue
  (admin panel > 💡 Ideas & Bugs) for open tester feedback, same habit as
  checking FIXES.txt itself (Sept 16, 2026) - it's the mechanism Kim
  built specifically so feedback doesn't need SMS/email to reach him.
  Act on anything worth doing: promote it into FIXES.txt's NEXT CHANGE
  LIST credited "Suggested by [name]" and mark that submission "On
  List" in Admin, then "Done" once it ships (or "Rejected" if decided
  against instead - Sept 18, 2026). Recurring, not a one-time task.
