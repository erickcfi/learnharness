-- North Aero Ground Tutor: metered usage, search counts, alerts, pause state.
-- PRD C3 req 4 to 7, D15, D16, D29, X2. RLS on, no allow rules (see the first migration).

-- One row per model call a tenant causes (C3 req 4, D29), written by the
-- metering proxy (X2). Dollars are at list price, worked out by the proxy.
create table public.model_usage (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	occurred_at timestamptz not null default now(),
	model text not null,
	input_tokens integer not null default 0 check (input_tokens >= 0),
	output_tokens integer not null default 0 check (output_tokens >= 0),
	cache_read_tokens integer not null default 0 check (cache_read_tokens >= 0),
	cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0),
	cost_usd numeric(12, 6) not null check (cost_usd >= 0),
	-- The provider's message ID, when known, so a retried record is not counted twice.
	request_id text unique
);
comment on table public.model_usage is 'One row per metered model call: tokens and list-price dollars (C3 req 4).';
create index model_usage_tenant_time_idx on public.model_usage (tenant_id, occurred_at);

alter table public.model_usage enable row level security;
revoke all on table public.model_usage from anon, authenticated;
grant select, insert, update, delete on table public.model_usage to service_role;

-- One row per web search (C3 req 7). The fee per search is stored with it.
create table public.search_usage (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	occurred_at timestamptz not null default now(),
	provider text not null default 'tavily',
	fee_usd numeric(10, 4) not null check (fee_usd >= 0)
);
comment on table public.search_usage is 'One row per web search and its fee (C3 req 7).';
create index search_usage_tenant_time_idx on public.search_usage (tenant_id, occurred_at);

alter table public.search_usage enable row level security;
revoke all on table public.search_usage from anon, authenticated;
grant select, insert, update, delete on table public.search_usage to service_role;

-- Cost alerts and autopause records (C3 req 5, D15). At most one open alert
-- per tenant and kind; the Owner clears it on the dashboard.
create table public.alerts (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	kind text not null check (kind in ('cost_alert', 'autopause')),
	threshold_usd numeric(10, 2) not null,
	window_cost_usd numeric(12, 6) not null,
	created_at timestamptz not null default now(),
	cleared_at timestamptz,
	cleared_by uuid references public.accounts (id) on delete set null
);
comment on table public.alerts is 'Cost alerts and autopause records, with the 30-day cost when each fired (C3 req 5).';
create unique index alerts_one_open_idx on public.alerts (tenant_id, kind) where cleared_at is null;
create index alerts_tenant_idx on public.alerts (tenant_id);
create index alerts_cleared_by_idx on public.alerts (cleared_by);

alter table public.alerts enable row level security;
revoke all on table public.alerts from anon, authenticated;
grant select, insert, update, delete on table public.alerts to service_role;

-- Pause state (C3 req 6, D16). An open row (no unpaused_at) means paused.
create table public.pauses (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	reason text not null check (reason in ('autopause', 'owner')),
	paused_at timestamptz not null default now(),
	paused_by uuid references public.accounts (id) on delete set null,
	unpaused_at timestamptz,
	unpaused_by uuid references public.accounts (id) on delete set null,
	constraint pauses_unpaused_after_paused check (unpaused_at is null or unpaused_at >= paused_at)
);
comment on table public.pauses is 'Pause history. A row with no unpaused_at means the tenant is paused now (C3 req 6).';
create unique index pauses_one_open_idx on public.pauses (tenant_id) where unpaused_at is null;
create index pauses_tenant_idx on public.pauses (tenant_id);
create index pauses_paused_by_idx on public.pauses (paused_by);
create index pauses_unpaused_by_idx on public.pauses (unpaused_by);

alter table public.pauses enable row level security;
revoke all on table public.pauses from anon, authenticated;
grant select, insert, update, delete on table public.pauses to service_role;

-- The identity sequences behind the ID columns: no rights for anon and authenticated.
revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
