-- Sept 17, 2026: two related additions.
--
-- 1. stays.billed_at - marks a stay as billed (the "Send Billing Text"
-- flow previously had no persisted record at all of whether a stay had
-- been billed; the new admin "unbilled stays" list needs this to know
-- what to show). Set once, when admin sends/confirms a bill from the new
-- consolidated billing-review list.
--
-- 2. stays.pickup_reminder_sent_at - same idempotency purpose as the
-- existing reminder_sent_at (drop-off reminder), but for the new "your
-- dog is ready for pickup tomorrow" message sent by send-pickup-reminders
-- the day before check_out, mirroring send-reminders' pattern exactly.

alter table public.stays
  add column if not exists billed_at timestamptz,
  add column if not exists pickup_reminder_sent_at timestamptz;

-- 4th admin-editable SMS template, same pattern as sms_confirmation/
-- sms_reminder/sms_billing (settings table, Sept 15/16).
alter table public.settings
  add column if not exists sms_pickup_reminder text not null default
    'It''s been wonderful having {dogName}! We have you down for pick up at {pickupDate} {pickupTime}. Please let us know in our shared group text thread if anything has changed. Otherwise, we''ll see you tomorrow at {pickupTime}.';

-- Same cron pattern as send-stay-reminders-daily (20260916000000
-- migration) - reuses the same cron_secret vault entry (send-pickup-
-- reminders checks the same CRON_SECRET Edge Function secret). Offset by
-- 5 minutes from the drop-off reminder cron so the two runs don't fire on
-- the exact same instant.
select cron.schedule(
  'send-pickup-reminders-daily',
  '5 16 * * *', -- 16:05 UTC = ~9:05am PDT / 8:05am PST
  $$
  select net.http_post(
    url := 'https://dmkfhcreqzmabeihqwgy.supabase.co/functions/v1/send-pickup-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
