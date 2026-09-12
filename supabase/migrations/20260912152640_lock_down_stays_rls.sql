-- Lock down the `stays` table.
--
-- Previously there was a single "Allow all" policy (cmd: ALL, qual: true)
-- applied to the `public` role, meaning anyone with the project's public
-- anon key — which ships in the client JS bundle on GitHub Pages — could
-- read, update, or delete every client's PII (name, phone, email,
-- signature, health/aggression notes) with a single unauthenticated
-- request. Confirmed live via a plain curl against the REST API.
--
-- New shape:
--   - anon may INSERT (the public booking form still works client-side)
--   - anon may NOT select/update/delete
--   - admin reads go through the `admin-data` Edge Function (service role
--     key, password checked server-side)
--   - returning-client autofill goes through the `lookup-client` Edge
--     Function, which returns only the safe-to-autofill fields rather
--     than the full row

drop policy if exists "Allow all" on public.stays;

create policy "public can submit bookings"
  on public.stays
  for insert
  to anon
  with check (true);
