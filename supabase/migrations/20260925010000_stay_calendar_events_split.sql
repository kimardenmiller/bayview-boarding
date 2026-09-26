-- Splits the single calendar event per stay into three (Sept 25, 2026,
-- on request - "add the event as an all-day event + add a 30m event for
-- pickup and drop"): an all-day block for the whole boarding duration,
-- plus a 30-minute timed event each for drop-off and pickup - clearer at
-- a glance than one timed event spanning the whole stay, and the actual
-- drop-off/pickup moments now show up as their own reminders.
--
-- Renamed rather than left as-is, since "calendar_event_id" stops being
-- accurate/unambiguous once there are three - this is specifically the
-- all-day one now. A same-day rename is safe: the feature only shipped
-- earlier today, so at most a handful of rows have anything in this
-- column yet, and syncStayCalendarEvent (admin-data) treats an existing
-- id here as "update in place" regardless of what shape the underlying
-- Google event currently is - the next edit/backfill simply converts it
-- from timed to all-day via a normal PATCH.
alter table public.stays
  rename column calendar_event_id to calendar_allday_event_id;

alter table public.stays
  add column if not exists calendar_dropoff_event_id text,
  add column if not exists calendar_pickup_event_id text;
