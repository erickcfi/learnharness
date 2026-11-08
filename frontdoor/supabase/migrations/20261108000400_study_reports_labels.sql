-- North Aero Ground Tutor: study time, report settings and sends, topic labels.
-- PRD PD1, X4, C6 req 3, C7 req 4, N7, N12, D26. RLS on, no allow rules.

-- Active study time (PD1), measured by the front door. One row per stretch
-- of activity; a heartbeat within the gap extends the open stretch.
create table public.study_time (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	-- The LearnHarness chat the time was spent in, when known.
	chat_id text,
	started_at timestamptz not null,
	last_active_at timestamptz not null,
	active_seconds integer not null default 0 check (active_seconds >= 0),
	constraint study_time_order check (last_active_at >= started_at)
);
comment on table public.study_time is 'Active study stretches per tenant and chat (PD1).';
create index study_time_tenant_started_idx on public.study_time (tenant_id, started_at);
create index study_time_tenant_last_idx on public.study_time (tenant_id, last_active_at);

alter table public.study_time enable row level security;
revoke all on table public.study_time from anon, authenticated;
grant select, insert, update, delete on table public.study_time to service_role;

-- Email report settings (C6 req 3, N12). Both reports start off until the
-- student turns them on in setup. Any address is allowed (D20).
create table public.report_settings (
	tenant_id uuid primary key references public.tenants (id) on delete cascade,
	session_report_enabled boolean not null default false,
	weekly_report_enabled boolean not null default false,
	report_email text,
	-- For the unsubscribe link in every report email.
	unsubscribe_token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
	updated_at timestamptz not null default now(),
	constraint report_settings_email_when_on check (
		not (session_report_enabled or weekly_report_enabled) or report_email is not null
	)
);
comment on table public.report_settings is 'Session-end and weekly report switches, the address, and the unsubscribe token (C6 req 3).';

alter table public.report_settings enable row level security;
revoke all on table public.report_settings from anon, authenticated;
grant select, insert, update, delete on table public.report_settings to service_role;

-- One row per report, claimed before sending, so no report goes out twice.
create table public.report_sends (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	kind text not null check (kind in ('session', 'weekly')),
	chat_id text,
	week_start date,
	claimed_at timestamptz not null default now(),
	sent_at timestamptz,
	provider_message_id text,
	constraint report_sends_shape check (
		(kind = 'session' and chat_id is not null and week_start is null)
		or (kind = 'weekly' and week_start is not null and chat_id is null)
	)
);
comment on table public.report_sends is 'Reports claimed and sent: one session report per chat, one weekly report per week.';
create unique index report_sends_session_once_idx on public.report_sends (tenant_id, chat_id) where kind = 'session';
create unique index report_sends_weekly_once_idx on public.report_sends (tenant_id, week_start) where kind = 'weekly';

alter table public.report_sends enable row level security;
revoke all on table public.report_sends from anon, authenticated;
grant select, insert, update, delete on table public.report_sends to service_role;

-- The non-aviation flag (C7 req 4, N7): Haiku's label for each session topic.
create table public.topic_labels (
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	chat_id text not null,
	topic text not null,
	is_aviation boolean not null,
	model text not null,
	labeled_at timestamptz not null default now(),
	primary key (tenant_id, chat_id)
);
comment on table public.topic_labels is 'Aviation or not-aviation label per session topic, for the dashboard flag (C7 req 4).';

alter table public.topic_labels enable row level security;
revoke all on table public.topic_labels from anon, authenticated;
grant select, insert, update, delete on table public.topic_labels to service_role;

-- The identity sequences behind the ID columns: no rights for anon and authenticated.
revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
