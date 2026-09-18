-- Sept 18, 2026, on request: a single shared "Text Message Footer"
-- ("Reply STOP to opt out...") replaces the copy that used to be baked
-- into the end of each of the 4 SMS templates individually - it's now
-- appended once, server-side, by send-confirmation itself, so admin
-- edits it in exactly one place instead of 4 (and can't let them drift
-- out of sync with each other the way 2 independent copies of any text
-- always eventually do in this project).
--
-- primary_manager_phone/secondary_manager_phone (renamed from the
-- {kimPhone}/{esteePhone} placeholder names, which were doing double
-- duty as both a var name and Kim/Estee's actual role) make those
-- numbers admin-editable for the first time - previously they only
-- existed as the KIM_PHONE/ESTEE_PHONE Supabase secrets, changeable
-- only via `supabase secrets set`. Deliberately still excluded from the
-- PUBLIC settings read (see supabase/functions/settings/index.ts's
-- PUBLIC_COLUMNS vs ADMIN_COLUMNS split) - the whole reason these were
-- kept out of this table in the first place (see the Sept 15 settings
-- migration's own notes) was that a public read must never leak a
-- personal cell number to every site visitor. That constraint is now
-- enforced by the Edge Function's own column selection rather than by
-- keeping the numbers out of the database entirely, since admin needs a
-- password-gated way to both read and write them.
--
-- No real phone numbers are set here - Claude has never been given
-- Kim/Estee's actual numbers and never should be; both columns start
-- blank and must be filled in once via Admin > SMS Message Templates.
--
-- The 4 existing SMS templates are reset to their current default
-- wording with the trailing footer text stripped out (previously each
-- one ended with its own copy of the "Reply STOP..." text baked
-- directly into the template) - left in place, the new server-side
-- auto-append would have produced every outbound text with that
-- paragraph twice. Safe to overwrite unconditionally here: confirmed via
-- a read-only query Sept 19, 2026 that the live row was still the exact
-- Sept 14 original text, meaning no admin customization exists yet to
-- lose.

alter table public.settings
  add column if not exists sms_footer text not null default
    'Reply STOP to opt out. Replies to this number aren''t monitored. For questions, please group-text Kim {primaryManagerPhone} & Estee {secondaryManagerPhone}.',
  add column if not exists primary_manager_phone text not null default '',
  add column if not exists secondary_manager_phone text not null default '';

update public.settings set
  sms_confirmation = 'Hi {firstName}! {dogName}''s stay at Bayview Boarding is confirmed. Drop-off: {dropDate} at {dropTime}. Pick-up: {pickDate} at {pickTime}. Estimated cost: ${estimatedCost}. — Kim & Estee',
  sms_reminder = 'Hi {firstName}! Just a reminder that {dogName}''s stay at Bayview Boarding starts tomorrow at {dropTime}. Here''s what to bring:
{packingList}
See you then! — Kim & Estee',
  sms_billing = 'Hi {firstName}! Thank you for visiting Bayview Boarding with {dogName}. Here''s your billing detail:
{billingBreakdown}
Total: ${finalCost}

Thanks for choosing Bayview Boarding! — Kim & Estee',
  sms_pickup_reminder = 'It''s been wonderful having {dogName}! We have you down for pick up at {pickupDate} {pickupTime}. Please let us know in our shared group text thread if anything has changed. Otherwise, we''ll see you tomorrow at {pickupTime}. — Kim & Estee',
  updated_at = now()
where id = true;

comment on column public.settings.sms_footer is
  'Appended once, server-side, to the end of every outbound client SMS (confirmation/reminder/billing/pickup) - not stored per-template, so it cannot drift out of sync across them.';
comment on column public.settings.primary_manager_phone is
  'Kim''s number, filled into {primaryManagerPhone} in sms_footer. Admin-only read/write (see settings/index.ts) - never returned by the public settings read.';
comment on column public.settings.secondary_manager_phone is
  'Estee''s number, filled into {secondaryManagerPhone} in sms_footer. Admin-only read/write (see settings/index.ts) - never returned by the public settings read.';
