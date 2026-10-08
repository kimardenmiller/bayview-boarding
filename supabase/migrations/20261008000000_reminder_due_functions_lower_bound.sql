-- Fixes a real bug reported Oct 8, 2026: "we generated the 'we'll see
-- you tomorrow' pickup text just after we modified the stay to end
-- right now, after an owner changed pickup from 26 hours from now to
-- now." due_dropoff_reminder_stay_ids()/due_pickup_reminder_stay_ids()
-- (the previous migration) only checked an UPPER bound - "moment <= now
-- + 24h" - with no lower bound at all, so a moment that's already in
-- the PAST (negative time remaining) still satisfies "<= now + 24h" and
-- counts as due. Editing a stay's pickup/drop-off time to "now" (or to
-- anything already past) made it instantly match on the very next
-- 15-minute cron tick, and the reminder-not-yet-sent stay got texted
-- with wording that assumes an UPCOMING moment, even though it had
-- already arrived or passed. Adding "> now()" as a lower bound restores
-- the intent these functions always had - "due" means "coming up
-- within the next 24 hours," not "anywhere at or before 24 hours from
-- now, including the entire past."
create or replace function public.due_dropoff_reminder_stay_ids()
returns setof uuid
language sql
stable
as $$
  select id from public.stays
  where reminder_sent_at is null
    and (check_in::timestamp + coalesce(drop_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' <= now() + interval '24 hours'
    and (check_in::timestamp + coalesce(drop_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' > now();
$$;

create or replace function public.due_pickup_reminder_stay_ids()
returns setof uuid
language sql
stable
as $$
  select id from public.stays
  where pickup_reminder_sent_at is null
    and (check_out::timestamp + coalesce(pickup_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' <= now() + interval '24 hours'
    and (check_out::timestamp + coalesce(pickup_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' > now();
$$;
