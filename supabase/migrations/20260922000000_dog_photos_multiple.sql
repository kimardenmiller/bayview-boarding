-- Allow multiple photos per dog, not just one (Sept 22, 2026, on
-- request). Replaces yesterday's single `photo_path` column on both
-- `dogs` and `stay_dogs` with an ORDERED `photo_paths` jsonb array -
-- jsonb rather than a plain text[] so display order is preserved
-- exactly as uploaded, same reasoning as settings.about_photos. Same
-- current-profile-vs-frozen-snapshot split as before: dogs.photo_paths
-- is the dog's current set, stay_dogs.photo_paths is what was actually
-- on file for THAT specific stay.
--
-- This feature shipped less than a day ago (see the Sept 21, 2026
-- migration), so it's extremely unlikely any real client has a photo
-- on file yet - but the backfill below is still correct/safe either
-- way: any existing single photo_path becomes a one-element array
-- before the old column is dropped, so nothing is lost if one exists.

alter table public.dogs
  add column if not exists photo_paths jsonb not null default '[]'::jsonb;

alter table public.stay_dogs
  add column if not exists photo_paths jsonb not null default '[]'::jsonb;

update public.dogs
  set photo_paths = jsonb_build_array(photo_path)
  where photo_path is not null;

update public.stay_dogs
  set photo_paths = jsonb_build_array(photo_path)
  where photo_path is not null;

alter table public.dogs drop column if exists photo_path;
alter table public.stay_dogs drop column if exists photo_path;
