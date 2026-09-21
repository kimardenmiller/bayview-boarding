-- Booking request/approval workflow (Sept 21, 2026, on request - see
-- Submit Idea from Estee: "Button to book stay should read 'Request
-- stay' and we need a place to approve or deny the stay in admin").
-- Scope decided in conversation: keep the "Book My Stay" button text
-- as-is, add explanatory copy instead; the client's confirmation text
-- waits until admin actually approves (previously sent automatically
-- at submission); a denial auto-texts the client, optionally with a
-- reason.
--
-- approval_status starts 'pending' for every NEW booking - a client
-- submission is now a request, not an instant booking. Every stay that
-- already existed before this migration is backfilled to 'approved'
-- (with approved_at set to when it was actually submitted) since it was
-- implicitly approved under the old model - nothing before today should
-- suddenly show up in the new "Requests" admin section needing a
-- decision that was never really pending.

alter table public.stays
  add column if not exists approval_status text not null default 'pending'
    check (approval_status in ('pending', 'approved', 'denied')),
  add column if not exists approved_at timestamptz,
  add column if not exists denied_at timestamptz,
  add column if not exists denial_reason text;

update public.stays
set approval_status = 'approved', approved_at = coalesce(submitted_at, created_at)
where approval_status = 'pending';

-- 2 new admin-editable SMS templates, same pattern/table as the
-- existing 4 (settings migrations, Sept 15/16/17). Both are PUBLIC
-- (not admin-only, unlike manager phones/default_broadcast_message) -
-- like the other 4 templates, the client's own browser needs to read
-- these to build the actual outbound text at submission/approval/
-- denial time.
alter table public.settings
  add column if not exists sms_request_received text not null default
    'Hi {firstName}! We''ve received your booking request for {dogName} - {dropDate} to {pickDate}. We''ll review it and confirm within 24 hours. Estimated cost: ${estimatedCost}.',
  add column if not exists sms_denied text not null default
    'Hi {firstName}! Unfortunately we''re unable to accept your booking request for {dogName} ({dropDate} - {pickDate}).{denialReason} Please feel free to reach out with any questions.';
