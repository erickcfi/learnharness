-- North Aero Ground Tutor: subscriptions, Stripe events, invoices, trial claims.
-- PRD C2 req 2, 4, 5, 9; C7 req 2 and 6; D8 to D14. RLS on, no allow rules.

-- Subscription and trial state, written by Stripe webhooks.
create table public.subscriptions (
	stripe_subscription_id text primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	-- Stripe's own status string (trialing, active, past_due, canceled, ...).
	-- Not limited here, so a new Stripe status never breaks a webhook.
	status text not null,
	plan text check (plan in ('monthly', 'three_month', 'annual')),
	price_id text,
	trial_start timestamptz,
	trial_end timestamptz,
	current_period_start timestamptz,
	current_period_end timestamptz,
	cancel_at_period_end boolean not null default false,
	canceled_at timestamptz,
	ended_at timestamptz,
	coupon_id text,
	promotion_code_id text,
	percent_off numeric(5, 2),
	-- The created time of the newest Stripe event applied to this row. An
	-- older event that arrives late is skipped.
	last_event_created_at timestamptz not null,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
comment on table public.subscriptions is 'Subscription and trial state from Stripe webhooks (C2).';
create index subscriptions_tenant_idx on public.subscriptions (tenant_id, created_at);

alter table public.subscriptions enable row level security;
revoke all on table public.subscriptions from anon, authenticated;
grant select, insert, update, delete on table public.subscriptions to service_role;

-- Each Stripe webhook event ID, stored once, so a repeated event changes
-- nothing (C2 req 9). Holds no personal data, and is kept after a tenant is deleted.
create table public.stripe_events (
	id text primary key,
	type text not null,
	stripe_created_at timestamptz not null,
	received_at timestamptz not null default now()
);
comment on table public.stripe_events is 'Stripe webhook event IDs already processed. A repeat is ignored (C2 req 9).';

alter table public.stripe_events enable row level security;
revoke all on table public.stripe_events from anon, authenticated;
grant select, insert, update, delete on table public.stripe_events to service_role;

-- Invoices from Stripe webhooks: revenue and trial-to-paid conversion (C7 req 2).
create table public.invoices (
	stripe_invoice_id text primary key,
	tenant_id uuid not null references public.tenants (id) on delete cascade,
	stripe_subscription_id text,
	status text not null,
	billing_reason text,
	amount_paid_cents integer not null default 0 check (amount_paid_cents >= 0),
	currency text not null default 'usd',
	paid_at timestamptz,
	period_start timestamptz,
	period_end timestamptz,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);
comment on table public.invoices is 'Stripe invoices: amounts paid, for revenue and conversion on the dashboard.';
create index invoices_tenant_idx on public.invoices (tenant_id, paid_at);

alter table public.invoices enable row level security;
revoke all on table public.invoices from anon, authenticated;
grant select, insert, update, delete on table public.invoices to service_role;

-- One trial per email and per card (C2 req 2, D10). Owner's choice
-- (2026-11-08): keep a keyed one-way hash of the email and Stripe's card
-- fingerprint, with no link to a tenant, so the record outlives the day-91
-- delete. Flagged for the legal review (T5) and the privacy policy.
create table public.trial_claims (
	id bigint generated always as identity primary key,
	email_hash text unique check (email_hash ~ '^[0-9a-f]{64}$'),
	card_fingerprint text unique,
	claimed_at timestamptz not null default now(),
	constraint trial_claims_has_key check (email_hash is not null or card_fingerprint is not null)
);
comment on table public.trial_claims is 'Emails (as keyed hashes) and card fingerprints that already had a trial. No tenant link; kept after deletion.';

alter table public.trial_claims enable row level security;
revoke all on table public.trial_claims from anon, authenticated;
grant select, insert, update, delete on table public.trial_claims to service_role;

-- The identity sequences behind the ID columns: no rights for anon and authenticated.
revoke all on all sequences in schema public from anon, authenticated;
grant usage, select on all sequences in schema public to service_role;
