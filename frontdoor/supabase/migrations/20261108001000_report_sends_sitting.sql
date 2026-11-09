-- North Aero Ground Tutor: one session report per study sitting (W2-10,
-- PRD C6 req 3, D26).
--
-- The first schema allowed one session report per tutor session (chat),
-- ever. Students come back to the same chat on later days, so those later
-- sittings would get no report. A sitting is a run of study activity with
-- no long gap (frontdoor/reports/sittings.ts); its first moment is its key.
--
-- Rows written before this change (no sitting time) keep the old rule:
-- one per chat. chat_id stays filled on every session row (the sitting's
-- main chat), so the shape check is unchanged.

alter table public.report_sends add column sitting_started_at timestamptz;
comment on column public.report_sends.sitting_started_at is 'Session reports: the start of the study sitting the report covers (its key).';

alter table public.report_sends add constraint report_sends_sitting_kind check (sitting_started_at is null or kind = 'session');

drop index public.report_sends_session_once_idx;
create unique index report_sends_session_once_idx on public.report_sends (tenant_id, chat_id) where kind = 'session' and sitting_started_at is null;
create unique index report_sends_sitting_once_idx on public.report_sends (tenant_id, sitting_started_at) where kind = 'session' and sitting_started_at is not null;
