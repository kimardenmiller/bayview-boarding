-- Multi-dog support (FIXES.txt item 6).
--
-- v1 scope: full intake (breed/DOB/vet/aggression/health) is still
-- collected for the primary dog only. This column just records how many
-- dogs are in the stay, for pricing (10% discount per additional dog,
-- see calcCost in src/App.js) and so admin can see it on the stay record.
-- Full per-dog intake for dogs 2+ is a follow-up, not in this pass.

alter table public.stays
  add column if not exists number_of_dogs integer not null default 1;

alter table public.stays
  add constraint stays_number_of_dogs_positive check (number_of_dogs >= 1);
