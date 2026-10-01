-- A "thank you + review request" text sent when admin marks a stay Paid
-- (Sept 30, 2026, on request) - previously markPaid was just a status
-- flip with no client-facing message at all (see stay_paid_at.sql's own
-- comment). Same singleton-row/admin-editable pattern as every other SMS
-- template - public-readable (AdminPanel needs to fetch and edit it,
-- same reasoning as sms_billing/sms_denied despite also being admin-
-- triggered only), admin-write-gated through the existing settings Edge
-- Function. The Google review link is the same fixed short link already
-- used in sms_billing's own default text, not a {placeholder} - it never
-- varies per stay.
alter table public.settings
  add column if not exists sms_paid text not null default
    'Hi {firstName}! We received your payment. Thank you!

If you have not done so already, please leave us a review: https://g.page/r/CX9YK-LEWX_nEAI/review

Thanks for choosing Bayview Boarding, and we''ll see you next time!

— Kim & Estee';
