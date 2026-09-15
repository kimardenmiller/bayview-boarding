-- Extends `settings` with the packing list and SMS message templates, and
-- adds a per-stay waiver snapshot to `stays`. Prompted by a scan (Sept 16,
-- 2026) for values that should be admin-editable like day rate/discount/
-- holiday/vets already are.
--
-- Packing list and SMS templates were previously hardcoded in TWO places
-- each (src/settings.js as a "reference copy" plus a second real copy
-- inside supabase/functions/send-confirmation/index.ts) - the packing
-- list had already drifted slightly between the two ("vet name, address &
-- phone" vs "vet name, address, and phone"). Moving them here gives a
-- single source of truth, same pattern as day_rate/vets.
--
-- The waiver snapshot is different in kind, not just another editable
-- value: it's not something an admin edits per-stay, it's captured
-- automatically at submission time so a LATER edit to the waiver's own
-- wording (src/waiver.js) can never retroactively make it ambiguous what
-- a past client actually read and signed. stay_dogs already does this for
-- each dog's declared profile; stays.waiver_snapshot does the equivalent
-- for the waiver text itself.

alter table public.settings
  add column if not exists packing_list text[] not null default array[
    'Food',
    'Leash & doggy bags',
    'Bed & favorite blanket',
    'Favorite treats',
    'Favorite toys',
    'Favorite food bowl (we provide a water bowl)',
    'Written special instructions including vet name, address, and phone'
  ],
  add column if not exists sms_confirmation text not null default
    'Hi {firstName}! {dogName}''s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${estimatedCost}. — Kim & Estee Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.',
  add column if not exists sms_reminder text not null default
    'Hi {firstName}! Just a reminder that {dogName}''s stay at Bayview Boarding starts tomorrow at {dropTime}. Here''s what to bring: {packingList}. See you then! Reply STOP to opt out. — Kim & Estee Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.',
  add column if not exists sms_billing text not null default
    'Hi {firstName}! {dogName} is ready for pickup. Your total for this stay is ${finalCost}. Thanks for choosing Bayview Boarding! Reply STOP to opt out. — Kim & Estee Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.';

alter table public.stays
  add column if not exists waiver_snapshot jsonb;

comment on column public.stays.waiver_snapshot is
  'Exact WAIVER_SECTIONS content (array of {title, body}) as shown and signed at the time of this booking - preserved so a later edit to src/waiver.js can never retroactively change what a past client is on record as having agreed to.';
