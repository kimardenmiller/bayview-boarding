-- Sept 19, 2026, on request: the tester broadcast's suggested starting
-- text (previously DEFAULT_BROADCAST_MESSAGE, hardcoded in App.js) is now
-- admin-editable and persisted, same pattern as the SMS templates/footer -
-- admin can now fine-tune the wording once and have it stick, instead of
-- it silently resetting to a hardcoded default after every send.
--
-- Admin-only, same as primary_manager_phone/secondary_manager_phone: this
-- text is only ever read from the admin-authenticated Testers panel, never
-- from the public settings read.
--
-- The default value is also updated here to point testers at the new
-- staging URL instead of production (see the staging-environment migration
-- this same round), with explicit "this is a sandbox" framing so testers
-- know they're free to make real bookings/add dogs/etc. without touching
-- real client data.

alter table public.settings
  add column if not exists default_broadcast_message text not null default
    'We''ve made a few changes to the Bayview Boarding site below. Please have a look and tell us what you think!
https://kimardenmiller.github.io/bayview-boarding/staging
This is our testing sandbox - feel free to make bookings, add dogs, and try anything. None of it touches real client data.
Then just tap the (☰) menu and choose "Submit Idea" to share your feedback with us.';

comment on column public.settings.default_broadcast_message is
  'Suggested starting text for the admin Testers broadcast compose box - fully editable before each send and saveable as the new default via "Save as Default". Admin-only read/write (see settings/index.ts) - never returned by the public settings read.';
