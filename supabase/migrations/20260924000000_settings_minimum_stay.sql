-- Admin-configurable minimum stay length, in days (Sept 24, 2026, on
-- request from Estee via Submit Idea - "24 hour minimum needs
-- updating. It's now prorating for less than 24 hour stay"). There was
-- never actually a minimum-stay rule wired up anywhere - src/settings.js
-- had a vestigial, never-referenced MIN_HOURS constant, but
-- calcCostBreakdown (App.js) always billed the exact fractional number
-- of hours booked, so e.g. a 6-hour same-day stay billed at 25% of a
-- full day's rate. minimum_stay is the floor calcCostBreakdown now
-- clamps up to before computing the day-by-day breakdown - same
-- singleton-row pattern as day_rate/multi_dog_discount/holiday_upcharge,
-- public (every visitor's browser needs it to show an accurate estimate
-- before submitting), admin-write-gated through the existing settings
-- Edge Function.
alter table public.settings
  add column if not exists minimum_stay numeric not null default 1;
