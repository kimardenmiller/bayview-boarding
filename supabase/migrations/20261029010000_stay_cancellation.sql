-- Client portal phase 2: cancellation (Oct 29, 2026, on request - see
-- FIXES.txt NEXT CHANGE LIST item 2). A client can cancel their own stay
-- from "My Stays": a pending request is always free; an approved stay
-- owes a fee (a % of its estimated_cost) set by how many hours are left
-- before its drop-off moment, per an admin-editable 3-tier policy. Always
-- the CURRENT policy - deliberately no per-stay snapshot (Kim manages
-- policy changes by hand).

-- 1. A 4th approval_status.
alter table public.stays drop constraint stays_approval_status_check;
alter table public.stays add constraint stays_approval_status_check
  check (approval_status in ('pending', 'approved', 'denied', 'cancelled'));

-- cancellation_fee is what's owed (0 for a free cancellation); a waived
-- fee keeps its amount for the record and just gets waived_at stamped.
alter table public.stays
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancellation_fee numeric,
  add column if not exists cancellation_fee_waived_at timestamptz;

-- 2. The policy + 2 new SMS templates. Exactly 3 tiers, as a jsonb object
-- (same passthrough style as about_photos): more than lateHours before
-- drop-off -> earlyFeePercent; within lateHours -> lateFeePercent; within
-- lastMinuteHours -> lastMinuteFeePercent. Defaults from Kim's "free >72
-- hours out, 50% refund <72 hours, 25% refund <24 hours", as fees.
alter table public.settings
  add column if not exists cancellation_policy jsonb not null default
    '{"lateHours": 72, "lastMinuteHours": 24, "earlyFeePercent": 0, "lateFeePercent": 50, "lastMinuteFeePercent": 75}'::jsonb,
  add column if not exists sms_cancelled text not null default
    E'Hi {firstName}! Your stay for {dogName} ({dropDate} - {pickDate}) has been cancelled.{cancellationFeeNote}\n— Kim & Estee',
  add column if not exists sms_cancellation_fee text not null default
    E'Hi {firstName}! Here''s the cancellation fee for {dogName}''s stay ({dropDate} - {pickDate}), per our cancellation policy:\n{billingBreakdown}\nTotal: ${finalCost}\n\nYou can make payment on Venmo @Kim-Miller or Zelle @(650) 302-0731.\n\n— Kim & Estee';

-- 3. Hours left before a stay's real drop-off moment, in the business's
-- own Pacific timezone - same moment calculation as
-- due_dropoff_reminder_stay_ids() (DST-safe only in Postgres, see that
-- migration). Negative once drop-off has passed.
create or replace function public.stay_hours_until_dropoff(stay_ids uuid[])
returns table (id uuid, hours double precision)
language sql
stable
as $$
  select id,
    extract(epoch from (
      (check_in::timestamp + coalesce(drop_time, time '09:00:00')) at time zone 'America/Los_Angeles'
    ) - now()) / 3600
  from public.stays
  where id = any(stay_ids);
$$;

-- 4. Reminders only for APPROVED stays. Found while adding cancellation:
-- neither function ever checked approval_status, so a pending request (or
-- a denied one) would get drop-off/pickup reminders too - and now a
-- cancelled one would. No stay had actually been hit yet (checked Oct
-- 29, 2026). Otherwise unchanged from 20261008000000.
create or replace function public.due_dropoff_reminder_stay_ids()
returns setof uuid
language sql
stable
as $$
  select id from public.stays
  where reminder_sent_at is null
    and approval_status = 'approved'
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
    and approval_status = 'approved'
    and (check_out::timestamp + coalesce(pickup_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' <= now() + interval '24 hours'
    and (check_out::timestamp + coalesce(pickup_time, time '09:00:00'))
        at time zone 'America/Los_Angeles' > now();
$$;
