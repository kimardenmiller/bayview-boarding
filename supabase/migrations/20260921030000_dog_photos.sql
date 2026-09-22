-- Lets an owner upload a photo of their dog during booking, visible to
-- admin when reviewing the request (Sept 21, 2026, on request).
--
-- `dogs.photo_path` is the dog's current/always-up-to-date photo, same
-- role as breed/DOB/spay-neuter/etc there. `stay_dogs.photo_path` is
-- the frozen snapshot of what photo (if any) was actually on file for
-- THIS specific stay, same reasoning as every other stay_dogs snapshot
-- column (see the Sept 14 dog-profiles reorg migration): a later
-- re-upload should never retroactively change what a past booking's
-- record shows. Both are nullable - a photo is optional, unlike the
-- required profile fields.
--
-- Unlike the "about-photos" bucket (Sept 21, 2026, earlier today), this
-- one is PRIVATE - a client's own dog photo is their data, tied to a
-- real booking, not public marketing content. Admin views it via a
-- signed URL generated server-side (admin-data, service role key),
-- never a public bucket URL; the owner's own upload flow also goes
-- through a dedicated Edge Function (dog-photos) using the service role
-- key, same reasoning as submit-booking's own public-but-mediated
-- writes (anon has no direct Storage access to this bucket at all).

alter table public.dogs
  add column if not exists photo_path text;

alter table public.stay_dogs
  add column if not exists photo_path text;

insert into storage.buckets (id, name, public)
values ('dog-photos', 'dog-photos', false)
on conflict (id) do nothing;
