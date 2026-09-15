-- Stay reminder SMS (FIXES.txt item 1): a daily cron job that finds
-- stays checking in the next day and sends a reminder text via the new
-- send-reminders Edge Function.

alter table public.stays
  add column if not exists reminder_sent_at timestamptz;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- The actual secret value is NEVER in this file (or any git-tracked
-- file) - it was created once via `vault.create_secret(...)` run
-- directly against the live database (not saved as a migration), and is
-- also set as the CRON_SECRET Edge Function secret via
-- `supabase secrets set`. This job only references it BY NAME through
-- vault.decrypted_secrets, which is safe to commit: reading this file
-- alone reveals nothing usable. See CLAUDE.md for how to reproduce this
-- setup (with a fresh secret) if the cron job is ever recreated.
select cron.schedule(
  'send-stay-reminders-daily',
  '0 16 * * *', -- 16:00 UTC = 9am PDT / 8am PST - a normal business hour
  $$
  select net.http_post(
    url := 'https://dmkfhcreqzmabeihqwgy.supabase.co/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
