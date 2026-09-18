-- Sept 18, 2026, on request: feedback.status gains 2 states admin uses to
-- track a submission through to an actual outcome, not just triage -
-- 'considered' renamed to 'on_list' (set once a submission is promoted
-- into FIXES.txt's NEXT CHANGE LIST - see the Rules section of
-- CLAUDE.md), plus new 'rejected' (decided not to do it). 'done' is
-- unchanged. Every status transition stays a manual admin action from
-- the Ideas & Bugs list, same as before - nothing here is automatic.

update public.feedback set status = 'on_list' where status = 'considered';

alter table public.feedback drop constraint feedback_status_check;
alter table public.feedback add constraint feedback_status_check
  check (status in ('open', 'on_list', 'done', 'rejected'));
