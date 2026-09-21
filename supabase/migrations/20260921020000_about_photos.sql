-- Admin-manageable About page photos (Sept 21, 2026, on request) -
-- previously a hardcoded array in src/App.js (ABOUT_PHOTOS), with order
-- baked into filenames (1-choco.jpeg, 2-milo.jpeg, ...) - changing
-- anything meant editing code and redeploying. The ordered list itself
-- (which photos, what order, each one's alt text) now lives in
-- `settings.about_photos` (same singleton-row pattern as vets/packing_list
-- - a jsonb array of {path, alt}, `path` being the file's location within
-- the new Storage bucket below) - public (every visitor's browser needs
-- it to render the About page), admin-write-gated through settings/
-- index.ts same as everything else there. The actual image files live in
-- Supabase Storage instead of the git-tracked public/ folder, since
-- that's the part a plain settings JSON column can't hold - see the new
-- supabase/functions/about-photos Edge Function for upload/delete
-- (Storage writes need the service role key, same reasoning as every
-- other write in this project).

alter table public.settings
  add column if not exists about_photos jsonb not null default '[]';

-- A public bucket (direct, unauthenticated read - same trust level as
-- the git-tracked public/img/about files these replace; nothing
-- sensitive lives in a dog-boarding marketing photo). Writes are NOT
-- opened up here - Storage's own object-level access is separate from
-- this row and defaults to service-role-only, which is exactly what's
-- wanted: only the about-photos Edge Function (service role key) can
-- upload or delete.
insert into storage.buckets (id, name, public)
values ('about-photos', 'about-photos', true)
on conflict (id) do nothing;
