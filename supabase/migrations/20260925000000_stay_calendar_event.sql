-- Each confirmed booking gets its own Google Calendar event (Sept 25,
-- 2026, on request) - calendar_event_id is the Google Calendar API's own
-- event id, stamped once admin-data's approveStay action successfully
-- creates the event (best-effort - a calendar hiccup never blocks
-- approving a stay, same reasoning as notifyOwnersOfClientText in
-- send-confirmation). Kept so a later correction to the stay's dates/
-- times (billStay/editStay) can find and update the SAME calendar
-- event instead of creating a duplicate, and so a future "cancel
-- booking" feature could delete it. Null for every stay that predates
-- this feature, or whose calendar event creation failed/was never
-- attempted (e.g. staging, which has no Google credentials configured -
-- same pattern as staging's missing Twilio credentials).
alter table public.stays
  add column if not exists calendar_event_id text;
