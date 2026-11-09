-- North Aero Ground Tutor: one session report per study sitting (W2-10,
-- PRD C6 req 3, D26; master decision 2026-11-08, Q1 option B).
--
-- The first schema allowed one session report per tutor session (chat),
-- ever. Students come back to the same chat on later days, so those later
-- sittings would get no report. A sitting is a run of study activity in any
-- chat with no gap over 30 minutes (frontdoor/reports/sittings.ts); its
-- first moment is its key. chat_id stays filled on every session row (the
-- sitting's main chat), so the shape check is unchanged.
--
-- Every session row the report loop writes has sitting_started_at, so the
-- session rule is now one per (tenant, sitting). A row with no sitting time
-- (only frontdoor/db's older claimReportSend writes one; the report loop
-- does not) keeps the old rule, one per chat.
--
-- Safe to run on a database that has only the earlier five migrations, and
-- safe to run twice: every step checks first.

alter table public.report_sends add column if not exists sitting_started_at timestamptz;
comment on column public.report_sends.sitting_started_at is 'Session reports: the start of the study sitting the report covers (its key).';

do $$
begin
	if not exists (select 1 from pg_constraint where conname = 'report_sends_sitting_kind' and conrelid = 'public.report_sends'::regclass) then
		alter table public.report_sends add constraint report_sends_sitting_kind check (sitting_started_at is null or kind = 'session');
	end if;
end
$$;

drop index if exists public.report_sends_session_once_idx;
create unique index if not exists report_sends_session_once_idx on public.report_sends (tenant_id, chat_id) where kind = 'session' and sitting_started_at is null;
create unique index if not exists report_sends_sitting_once_idx on public.report_sends (tenant_id, sitting_started_at) where kind = 'session' and sitting_started_at is not null;
