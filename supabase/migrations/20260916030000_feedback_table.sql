-- "Submit Idea" feature (Sept 16, 2026): lets testers report bugs/ideas/
-- feedback through the site instead of a text message (SMS costs money
-- per send, and a text thread isn't a workflow - things get lost). Every
-- submission is persisted here so Kim/Estee can actually triage it over
-- time from the admin panel, with a simple open -> considered -> done
-- status instead of relying on scrollback.
--
-- Same RLS-locked-with-zero-policies pattern as every other table since
-- the Sept 12 lockdown: anon gets no direct access at all. Submitting is
-- public/unauthenticated (any visitor can leave feedback, no login
-- needed) but goes through the `feedback` Edge Function using the
-- service role key; listing and updating status require the admin
-- password, checked in that same function.

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  name text,
  contact text,
  category text not null default 'idea' check (category in ('bug', 'idea', 'other')),
  message text not null,
  status text not null default 'open' check (status in ('open', 'considered', 'done')),
  created_at timestamptz not null default now()
);

alter table public.feedback enable row level security;
