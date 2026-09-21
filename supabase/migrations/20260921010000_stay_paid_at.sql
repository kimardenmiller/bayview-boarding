-- Payment tracking (Sept 21, 2026, on request) - "billed" alone never
-- answered "has this actually been paid?" Admin now marks a stay paid
-- once payment is actually received; until then it shows in a new
-- "Awaiting Payment" admin section (billed but not yet paid), and once
-- marked, it moves into Past Stays showing "Paid" - the same section a
-- billed-and-paid stay always lived in, just with that status now
-- visible instead of implied.

alter table public.stays
  add column if not exists paid_at timestamptz;

-- Every stay already billed before this migration is backfilled to
-- paid (paid_at = billed_at) - same reasoning as the approval_status
-- backfill in the Sept 21, 2026 stay_approval_workflow migration:
-- payment tracking is new today, but this business has actually been
-- getting paid all along, so nothing already on file should suddenly
-- need a decision that was never really pending. Only genuinely new
-- bills, from here on, start unpaid.
update public.stays
set paid_at = billed_at
where billed_at is not null and paid_at is null;
