-- Client portal ("My Stays", Oct 29, 2026, on request - see FIXES.txt
-- NEXT CHANGE LIST item 2). A client logs in with their phone number +
-- a 6-digit code texted to it (no password), and stays logged in for 6
-- months via a session token. Both tables are only ever touched by the
-- `portal` Edge Function (service role) - same RLS-locked-with-zero-
-- policies pattern as owners/dogs/stays/stay_dogs/settings.
--
-- Neither the code nor the session token is stored in plain text, only
-- its SHA-256 hash, so a leaked row can't be replayed.

create table public.portal_login_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  code_hash text not null,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index portal_login_codes_phone_idx on public.portal_login_codes (phone, created_at desc);
alter table public.portal_login_codes enable row level security;

create table public.portal_sessions (
  token_hash text primary key,
  owner_id uuid not null references public.owners(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now()
);
create index portal_sessions_owner_idx on public.portal_sessions (owner_id);
alter table public.portal_sessions enable row level security;
