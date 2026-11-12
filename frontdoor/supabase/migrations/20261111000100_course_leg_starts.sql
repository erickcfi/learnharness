-- North Aero Ground Tutor: course Leg starts (master decision, 2026-11-11).
--
-- When a student presses "Start lesson" on /course, the front door opens a
-- new tutor chat for that Leg and stores one row here: the tenant, the
-- Leg's id from the course file, the chat it opened, and when. The /course
-- page then shows "Started" on the Leg and a "Continue" link to the newest
-- chat. "Done" is not tracked in this version.
--
-- The page works before this file is applied: without the table it shows no
-- marks and logs one line (frontdoor/course/marks.ts).
--
-- Same lockdown as every table (frontdoor/db/README.md): row-level security
-- on with no allow rules, no rights for anon and authenticated, and only the
-- server (service_role) reads and writes. Deleting a tenant removes its rows.

create table public.course_leg_starts (
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	leg_id text not null check (char_length(leg_id) between 1 and 80),
	chat_id text not null check (char_length(chat_id) between 1 and 128),
	started_at timestamptz not null default now(),
	primary key (tenant_id, chat_id)
);
comment on table public.course_leg_starts is 'Course Legs a student started on /course, and the chat each start opened.';

create index course_leg_starts_tenant_started on public.course_leg_starts (tenant_id, started_at desc);

alter table public.course_leg_starts enable row level security;
revoke all on table public.course_leg_starts from anon, authenticated;
grant select, insert, update, delete on table public.course_leg_starts to service_role;
