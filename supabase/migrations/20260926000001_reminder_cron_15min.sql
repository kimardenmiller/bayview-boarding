-- Replaces the once-daily reminder cron schedules with a 15-minute
-- cadence (Sept 26, 2026 - see the previous migration's comment for
-- why), now that "due" is a precise, moving 24-hour window rather than
-- a once-a-day calendar-date match - a job that only ran once a day
-- could never catch that window at the right moment regardless of how
-- the "due" query itself worked.
--
-- PRODUCTION ONLY, deliberately: staging has never had these cron jobs
-- scheduled at all (see CLAUDE.md's Staging environment section - its
-- schema bootstrap already skips both original cron.schedule() calls,
-- since they only make sense against a real deployed cron target).
-- Conditional on the job actually existing first, so this migration is
-- still safe to run as-is against a database that never had the old
-- schedule (e.g. if staging's bootstrap process is ever redone from
-- this point forward) rather than erroring on a missing job name.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'send-stay-reminders-daily') then
    perform cron.unschedule('send-stay-reminders-daily');
  end if;
  if exists (select 1 from cron.job where jobname = 'send-pickup-reminders-daily') then
    perform cron.unschedule('send-pickup-reminders-daily');
  end if;
end $$;

select cron.schedule(
  'send-stay-reminders-every-15-min',
  '*/15 * * * *',
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

-- Same 5-minute offset from the drop-off job as before, so the two
-- runs never fire on the exact same instant.
select cron.schedule(
  'send-stay-pickup-reminders-every-15-min',
  '5-59/15 * * * *',
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
