-- Client portal phase 3 (Oct 30, 2026 - see FIXES.txt NEXT CHANGE LIST
-- item 2): a client can ask to change a stay's dates from "My Stays".
-- That submits a NEW pending request pointing back at the stay it would
-- replace; the original stays exactly as it is until admin approves the
-- change, at which point admin-data's approveStay cancels the original
-- with NO fee (a date change never incurs one) and removes its calendar
-- events. Denying the change leaves the original untouched.
--
-- Only ever set by submit-booking, and only for a request carrying a
-- valid portal session that owns the original stay.
alter table public.stays
  add column if not exists replaces_stay_id uuid references public.stays(id) on delete set null;
