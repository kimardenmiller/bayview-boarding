-- Puts the "Replies to this number aren't monitored..." footer on its own
-- line in all 3 SMS templates, instead of running on as one sentence right
-- after "— Kim & Estee" (Kim's request, Sept 16, 2026). Updates both the
-- column defaults (for a fresh install) and the existing live row (an
-- `alter column ... set default` alone would not retroactively change
-- data already in the singleton settings row).

alter table public.settings
  alter column sms_confirmation set default
    'Hi {firstName}! {dogName}''s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${estimatedCost}. — Kim & Estee
Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.',
  alter column sms_reminder set default
    'Hi {firstName}! Just a reminder that {dogName}''s stay at Bayview Boarding starts tomorrow at {dropTime}. Here''s what to bring: {packingList}. See you then! Reply STOP to opt out. — Kim & Estee
Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.',
  alter column sms_billing set default
    'Hi {firstName}! {dogName} is ready for pickup. Your total for this stay is ${finalCost}. Thanks for choosing Bayview Boarding! Reply STOP to opt out. — Kim & Estee
Replies to this number aren''t monitored. For questions, please group-text Kim {kimPhone} & Estee {esteePhone}.';

-- Only touch rows that still have the OLD (space-joined, no-line-break)
-- wording, so this is a no-op / safe to re-run - and so it doesn't clobber
-- an admin's own custom-edited template text that happens not to match
-- either the old or new default exactly.
update public.settings
set
  sms_confirmation = replace(sms_confirmation, '— Kim & Estee Replies to this number', '— Kim & Estee
Replies to this number'),
  sms_reminder = replace(sms_reminder, '— Kim & Estee Replies to this number', '— Kim & Estee
Replies to this number'),
  sms_billing = replace(sms_billing, '— Kim & Estee Replies to this number', '— Kim & Estee
Replies to this number')
where id = true;
