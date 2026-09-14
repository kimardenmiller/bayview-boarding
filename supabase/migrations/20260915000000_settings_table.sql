-- Admin-configurable business settings (day rate, multi-dog discount %,
-- holiday upcharge %, and the vet clinic list), persisted so they survive
-- a page refresh instead of resetting to hardcoded defaults - the day
-- rate had exactly this problem before this migration (FIXES.txt items
-- 3 & 4), and a vet-list "maintenance" feature would be nearly useless
-- if it reset on every reload.
--
-- A singleton row (id is a boolean constrained to true, so only one row
-- can ever exist - a common trick for single-row config tables).
--
-- RLS-locked with zero policies, consistent with every other table in
-- this project since the Sept 12 lockdown: anon gets no direct access at
-- all. Reads are public (every visitor's browser needs the vet list and
-- current pricing to build the booking form and estimate cost) but go
-- through the `settings` Edge Function using the service role key, same
-- as lookup-client's public-but-mediated reads. Writes additionally
-- require the admin password, checked server-side in that same function.

create table public.settings (
  id boolean primary key default true,
  day_rate numeric not null default 105,
  multi_dog_discount numeric not null default 0.10,
  holiday_upcharge numeric not null default 0.30,
  vets text[] not null default array[
    'Marin Pet Hospital — (415) 479-8387',
    'VCA Marin Animal Hospital — (415) 454-5225',
    'Bel Marin Animal Hospital — (415) 883-1700',
    'Lucas Valley Animal Hospital — (415) 472-4552',
    'Northgate Animal Hospital — (415) 472-1000',
    'San Rafael Animal Hospital — (415) 456-1411',
    'Canal Animal Hospital — (415) 455-9855',
    'Marin Humane Veterinary Services — (415) 506-6225'
  ],
  updated_at timestamptz not null default now(),
  constraint settings_singleton check (id)
);

alter table public.settings enable row level security;

insert into public.settings (id) values (true);
