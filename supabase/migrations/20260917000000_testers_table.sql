-- Tester broadcast feature (Sept 17, 2026): Kim maintains a list of
-- testers (name + phone) from the admin panel, and can compose a message
-- there ("I've just made XYZ changes, please have a look") that gets
-- texted to all of them, with a fixed instructional footer explaining how
-- to get to the "Submit Idea" menu item - so testers always know how to
-- get back to feedback without Kim re-typing directions every time.
--
-- Same RLS-locked-with-zero-policies pattern as everything else: anon
-- gets no direct access at all. Unlike `feedback`/`settings`, there is no
-- public branch here at all - listing, adding, removing, and sending are
-- ALL admin-password-gated (same shape as admin-data), since a tester's
-- phone number is contact info, not something any visitor should be able
-- to read or add to.

create table public.testers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.testers enable row level security;
