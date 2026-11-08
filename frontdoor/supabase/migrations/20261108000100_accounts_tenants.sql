-- North Aero Ground Tutor: accounts, tenants, roles, consents.
-- PRD C1 req 2, 5, 6, 7; C7 req 1 and 3; section 3 (roles); D19, D25, D27, D28; PD5.
--
-- Access model (Owner's choice, 2026-11-08): row-level security is on for
-- every table, with no allow rules, and Supabase's anon and authenticated
-- roles get no table rights. Only the tutor's server reads and writes, over a
-- direct connection as the table owner (or service_role).

-- One row per login: student, Owner or staff.
create table public.accounts (
	id uuid primary key default gen_random_uuid(),
	clerk_user_id text not null unique,
	-- The "I am 18 or older" checkbox at signup (C1 req 5, D28). Required.
	age_18_confirmed_at timestamptz not null,
	created_at timestamptz not null default now()
);
comment on table public.accounts is 'One row per login (student, Owner, staff). Clerk user ID and the 18+ confirmation date.';

alter table public.accounts enable row level security;
revoke all on table public.accounts from anon, authenticated;
grant select, insert, update, delete on table public.accounts to service_role;

-- One tenant per student account: the study space on the Railway volume.
create table public.tenants (
	id uuid primary key default gen_random_uuid(),
	account_id uuid not null unique references public.accounts (id) on delete cascade,
	-- The tenant folder, relative to the volume: <volume>/tenants/<tenantId>/ (C1 req 2).
	folder text generated always as ('tenants/' || id::text) stored unique,
	-- provisioning: folder being made. ready: in service. retention: the
	-- subscription ended; read and export only until retention_ends_at (C1 req 6).
	status text not null default 'provisioning' check (status in ('provisioning', 'ready', 'retention')),
	stripe_customer_id text unique,
	created_at timestamptz not null default now(),
	ready_at timestamptz,
	retention_ends_at timestamptz,
	constraint tenants_retention_has_end check ((status = 'retention') = (retention_ends_at is not null))
);
comment on table public.tenants is 'One tenant per student account: folder mapping, life status, retention end, Stripe customer.';

alter table public.tenants enable row level security;
revoke all on table public.tenants from anon, authenticated;
grant select, insert, update, delete on table public.tenants to service_role;

-- Roles stored in the tutor's database (C7 req 1, D27). No row means student.
create table public.account_roles (
	account_id uuid not null references public.accounts (id) on delete cascade,
	role text not null check (role in ('owner', 'staff')),
	granted_at timestamptz not null default now(),
	granted_by uuid references public.accounts (id) on delete set null,
	primary key (account_id, role)
);
comment on table public.account_roles is 'Owner and staff roles. An account with no row is a student.';
create index account_roles_granted_by_idx on public.account_roles (granted_by);

alter table public.account_roles enable row level security;
revoke all on table public.account_roles from anon, authenticated;
grant select, insert, update, delete on table public.account_roles to service_role;

-- Consents with dates (C7 req 3, D19): the student's session-text opt-in,
-- and a tester's written OK. A revoked consent keeps its row as history.
create table public.consents (
	id bigint generated always as identity primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	kind text not null check (kind in ('session_text_opt_in', 'tester_written_ok')),
	granted_at timestamptz not null default now(),
	revoked_at timestamptz,
	recorded_by uuid references public.accounts (id) on delete set null,
	note text,
	constraint consents_revoked_after_granted check (revoked_at is null or revoked_at >= granted_at)
);
comment on table public.consents is 'Session-text opt-in and tester written OK, each with its grant and revoke dates.';
create unique index consents_one_active_idx on public.consents (tenant_id, kind) where revoked_at is null;
create index consents_tenant_idx on public.consents (tenant_id);
create index consents_recorded_by_idx on public.consents (recorded_by);

alter table public.consents enable row level security;
revoke all on table public.consents from anon, authenticated;
grant select, insert, update, delete on table public.consents to service_role;

-- The identity sequences behind the ID columns: no rights for anon and authenticated.
revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
