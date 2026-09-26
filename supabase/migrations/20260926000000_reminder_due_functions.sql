-- Precise "24 hours before" reminder timing (Sept 26, 2026, on request -
-- "the pickup reminder just went out to Tom Maddox, but pickup is not
-- 24 hours away yet"). Both send-reminders (drop-off) and send-pickup-
-- reminders previously ran once a day at a fixed cron time and matched
-- on calendar DATE alone ("check_in/check_out is tomorrow") - so a stay
-- with a late drop-off/pickup time got reminded anywhere from ~21 to
-- ~33+ hours early, not a consistent 24 (see CLAUDE.md's Reminders
-- section). These functions instead compute each stay's real drop-off/
-- pickup MOMENT (date + time, in the business's own Pacific timezone)
-- and return only the stays whose moment is now within 24 hours -
-- correct across a DST transition too, which plain JS date math (as the
-- Edge Functions previously did entirely on their own) can't do
-- reliably against a NAMED timezone without a real timezone library.
-- Used by both environments (staging included) - only the cron schedule
-- that calls these on a timer is production-only, see the next
-- migration.
create or replace function public.due_dropoff_reminder_stay_ids()
returns setof uuid
language sql
stable
as $$
  select id from public.stays
  where reminder_sent_at is null
    and (check_in::timestamp + coalesce(drop_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' <= now() + interval '24 hours';
$$;

create or replace function public.due_pickup_reminder_stay_ids()
returns setof uuid
language sql
stable
as $$
  select id from public.stays
  where pickup_reminder_sent_at is null
    and (check_out::timestamp + coalesce(pickup_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' <= now() + interval '24 hours';
$$;
