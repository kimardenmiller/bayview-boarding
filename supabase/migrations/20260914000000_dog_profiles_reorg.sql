-- Reorg the schema around dog-centric profiles (FIXES.txt item 6 follow-up).
--
-- Previous shape: one flat `stays` row per booking, embedding a single
-- dog's full profile plus owner info directly on the row. That meant a
-- returning dog's profile was really just "whatever the last stay row
-- said", duplicated across every stay, and a stay could only ever record
-- one dog's full details even though number_of_dogs (added Sept 13) let
-- a booking cover more than one.
--
-- New shape:
--   owners    - one row per client, keyed by phone. Also holds vet_name,
--               since the booking form now asks for the vet once per
--               booking (owner-level), not once per dog.
--   dogs      - one row per dog, owned by an owner. Always-current
--               profile: breed, DOB, spay/neuter, aggression, health -
--               kept up to date as the owner rebooks.
--   stays     - one row per booking (dates, times, cost, signature),
--               linked to an owner.
--   stay_dogs - join table: which dogs were on a given stay. Also
--               carries its own frozen copy of that dog's profile
--               fields (name/breed/DOB/spay-neuter/aggression/health) AS
--               DECLARED AND SIGNED for that specific booking. This is
--               deliberate, not redundant: `dogs` answers "what do we
--               currently know about this dog", but the signed waiver
--               attests to whatever was declared at that moment - if an
--               answer is later updated, the historical stay record must
--               still show what was actually on file when it was signed
--               (Sept 14 scope decision, given the liability angle).
--
-- All four tables are RLS-locked with zero policies - no anon or
-- authenticated access at all. The old anon-INSERT policy on `stays`
-- worked because a single insert was self-contained; this shape needs
-- upsert-by-phone / upsert-by-(owner,name) logic (find-or-create) which
-- requires a SELECT anon was never granted, so all writes now go
-- through the submit-booking Edge Function using the service role key.
-- Reads already went through admin-data / lookup-client (service role)
-- since the Sept 12 RLS lockdown - this extends the same pattern to
-- writes.
--
-- The original `stays` table is kept as `stays_legacy` (RLS-locked, no
-- policies) for audit/reference rather than dropped, and is backfilled
-- into the new tables below so existing clients' history isn't lost.

alter table public.stays rename to stays_legacy;
drop policy if exists "public can submit bookings" on public.stays_legacy;

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text not null,
  email text not null,
  vet_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.owners enable row level security;

create table public.dogs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id) on delete cascade,
  name text not null,
  breed text not null,
  dob date,
  spay_neuter text,
  aggression_history text,
  aggression_detail text,
  health_concerns text,
  health_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index dogs_owner_name_unique on public.dogs (owner_id, lower(name));
alter table public.dogs enable row level security;

create table public.stays (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.owners(id),
  check_in date not null,
  check_out date not null,
  drop_time time,
  pickup_time time,
  notes text,
  estimated_cost numeric,
  number_of_dogs integer not null default 1,
  signature text not null,
  client_timezone text,
  submitted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.stays enable row level security;

create table public.stay_dogs (
  stay_id uuid not null references public.stays(id) on delete cascade,
  dog_id uuid not null references public.dogs(id) on delete cascade,
  -- Frozen snapshot as declared/signed for this specific stay - see note
  -- above. Deliberately duplicates columns also on `dogs`.
  name text not null,
  breed text not null,
  dob date,
  spay_neuter text,
  aggression_history text,
  aggression_detail text,
  health_concerns text,
  health_detail text,
  primary key (stay_id, dog_id)
);
alter table public.stay_dogs enable row level security;

-- ── Backfill from stays_legacy ──────────────────────────────────────────────

-- One owner per distinct phone; name/email/vet_name taken from that
-- owner's most recent legacy stay.
insert into public.owners (phone, name, email, vet_name)
select distinct on (owner_phone)
  owner_phone, owner_name, owner_email, nullif(vet_name, 'Select a veterinarian')
from public.stays_legacy
where owner_phone is not null
order by owner_phone, submitted_at desc nulls last, created_at desc;

-- One dog per distinct (owner, lower(name)); profile fields taken from
-- that dog's most recent legacy stay.
insert into public.dogs (owner_id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail)
select distinct on (o.id, lower(sl.dog_name))
  o.id, sl.dog_name, sl.dog_breed, sl.dog_dob, sl.spay_neuter,
  sl.aggression_history, sl.aggression_detail, sl.health_concerns, sl.health_detail
from public.stays_legacy sl
join public.owners o on o.phone = sl.owner_phone
where sl.dog_name is not null
order by o.id, lower(sl.dog_name), sl.submitted_at desc nulls last, sl.created_at desc;

-- One stay per legacy row. legacy_stay_id is a temporary scratch column
-- used only to wire up stay_dogs below, then dropped.
alter table public.stays add column legacy_stay_id uuid;

insert into public.stays (owner_id, check_in, check_out, drop_time, pickup_time, notes, estimated_cost, number_of_dogs, signature, client_timezone, submitted_at, created_at, legacy_stay_id)
select
  o.id, sl.check_in, sl.check_out, sl.drop_time, sl.pickup_time, sl.notes, sl.estimated_cost,
  coalesce(sl.number_of_dogs, 1), coalesce(sl.signature, ''), sl.client_timezone,
  coalesce(sl.submitted_at, sl.created_at, now()), coalesce(sl.created_at, now()), sl.id
from public.stays_legacy sl
join public.owners o on o.phone = sl.owner_phone;

-- The snapshot columns are filled straight from stays_legacy - that IS
-- what was declared/signed for that legacy stay, so it doubles as the
-- correct historical snapshot with no extra logic needed.
insert into public.stay_dogs (stay_id, dog_id, name, breed, dob, spay_neuter, aggression_history, aggression_detail, health_concerns, health_detail)
select s.id, d.id, sl.dog_name, sl.dog_breed, sl.dog_dob, sl.spay_neuter,
  sl.aggression_history, sl.aggression_detail, sl.health_concerns, sl.health_detail
from public.stays s
join public.stays_legacy sl on sl.id = s.legacy_stay_id
join public.owners o on o.phone = sl.owner_phone
join public.dogs d on d.owner_id = o.id and lower(d.name) = lower(sl.dog_name)
where sl.dog_name is not null;

alter table public.stays drop column legacy_stay_id;

-- Safety net: abort (and roll back everything above - a Postgres error
-- aborts the whole batch) if the backfill didn't fully account for every
-- legacy row, rather than silently leaving data behind.
do $$
declare
  legacy_count integer;
  new_stays_count integer;
  new_links_count integer;
begin
  select count(*) into legacy_count from public.stays_legacy;
  select count(*) into new_stays_count from public.stays;
  select count(*) into new_links_count from public.stay_dogs;
  if new_stays_count <> legacy_count then
    raise exception 'Backfill mismatch: % legacy stays but % new stays rows', legacy_count, new_stays_count;
  end if;
  if new_links_count <> legacy_count then
    raise exception 'Backfill mismatch: % legacy stays but % stay_dogs links (expected 1 dog link per legacy stay)', legacy_count, new_links_count;
  end if;
end $$;
