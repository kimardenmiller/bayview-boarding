# Where things stand (Nov 20, 2026)

A pick-up-where-we-left-off note for working on this repo from another
computer. CLAUDE.md is the full project brief and FIXES.txt is the
backlog; this file only covers what's current or still open.

## Shipped and live

- **v1.49.1 (Nov 3)** - Photos are shrunk in the browser before upload
  (src/resizeImage.js), for both Admin > About Photos and the dog photo
  picker. This came out of a Supabase outage, described below.
- **v1.47-1.49 (Oct 29-30)** - All 3 phases of the "My Stays" client
  portal: texted-code login, cancelling under the fee policy, editing
  info and dog profiles, changing dates, and "Book again".
- 285 Jest tests pass. Everything is committed and pushed to `main`, and
  the live site is on the latest build.

## The Nov 3 Supabase outage (resolved)

- The free plan's 5.5 GB monthly bandwidth ran out (7.77 GB used).
  Supabase then blocked every request with a 402 for most of Nov 3, so
  the site, booking, Admin, and reminders were all down. Service came
  back at 6:30 PM.
- **Cause:** the 9 About gallery photos were full-size phone uploads of
  2-6 MB each. Every visitor who scrolled to About Us downloaded about
  37 MB.
- **Fix:**
  - New uploads are now resized automatically.
  - All 17 existing photos over 600 KB were recompressed in place, under
    the same file names. About photos went from 36.9 MB to 3.3 MB, and
    dog photos from 32.9 MB to 4.5 MB.
- **Still on the free plan.** Pro costs $25/month and allows 250 GB.
  Check the Supabase usage dashboard now and then. If it ever blocks
  again, Pro restores service immediately.
- The full-size originals were backed up to a temp folder on the old
  computer, which may since have been cleared.

## Open items

1. **Delete Estee's My Stays test data.** She finished testing: a date
   change was approved and then cancelled. Clean it up only with Kim's
   OK, then verify it's gone.
   - Owner `6c9eb8e3-3a8b-42bc-8e7f-3e96ff84673a`
   - Stays `a335b6b8-e6e0-49f2-89dd-ef6aed903012` (Marley, Nov 16-21,
     cancelled/replaced) and `aeaa99c8-1728-4f0e-8017-9da486a234ec`
     (the date change, Nov 18-24, cancelled)
   - Dog Marley `61f54b4e-60e0-4103-aaa9-16783961e2cc`
   - Her rows in `portal_sessions` and `portal_login_codes`
   - Any photos she uploaded while testing
2. **One open Submit Idea item** (Estee, Oct 29): "login was seamless,
   but the code text took about a minute to arrive." This is likely
   Twilio/carrier delivery delay rather than a bug. Decide whether to
   act on it (for example, add "may take a minute" text on the code
   screen), then mark it On List, Done, or Rejected in Admin.
3. **Google Ads** (checked Nov 8, campaign "Dog Boarding in San Rafael,
   CA", Performance Max, $4.50/day):
   - Last 30 days: 58 clicks, $87.75, 4 conversions (about $22 each).
   - The last week was weak: 3 clicks, $4.98 per click, 0 conversions.
     That's probably partly the outage.
   - It's "Limited by budget."
   - There was a $500 credit offer that required spending $386 more by
     Nov 25, which is unlikely at $4.50/day (Kim's call).
   - An old paused "Campaign #1" with a spokenvote.org ad could be
     removed.
   - Worth re-checking now that the site has been stable for 2+ weeks.
4. **GitHub Dependabot:** 37 alerts (1 critical, 11 high), almost
   certainly all inside Create React App's build tooling. See FIXES.txt
   DEFERRED (the CRA-to-Vite migration).
5. Older ideas, not started: a Master Client List tab, Ads location
   targeting, and sitelinks/video for Ads.

## Setting up the other computer

- **Tools:** Node/npm, the Supabase CLI (`supabase login`, then
  `supabase link --project-ref dmkfhcreqzmabeihqwgy`), Deno (for the
  Edge Function tests), and `gh`. You also need GitHub push access for
  `gh-pages` deploys.
- **Run tests:** `CI=true npx react-scripts test --watchAll=false`
- **Deploy the front end:** `CI=true npm run build`, then
  `npx gh-pages -d build --add`.
- **If the repo is in Dropbox there too:** builds and installs can hang.
  Rsync to a folder outside Dropbox, build there, then copy `build/`
  back. CLAUDE.md has the details.
- **Deploy Edge Functions:** `supabase functions deploy <name>`.
  send-reminders, send-pickup-reminders, and receive-sms need
  `--no-verify-jwt` on every deploy.
- **Production only:** staging was retired Oct 8, so don't deploy to it.
- **Live testing:** use 555-01XX phone numbers (for example 415-555-0199).
  Clean up any live test writes right away.
- **Claude's memory doesn't sync between computers** (it lives in
  ~/.claude). The habits it held:
  - Every round, run tests, deploy, verify live, update
    FIXES.txt/CLAUDE.md, and commit as "v1.x - description".
  - At the start of each session, check the Submit Idea queue.
