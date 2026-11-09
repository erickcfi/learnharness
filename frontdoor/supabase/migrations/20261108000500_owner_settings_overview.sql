-- North Aero Ground Tutor: the Owner's thresholds and the dashboard status view.
-- PRD C3 req 5, C7 req 2 and 5, D15. RLS on, no allow rules.

-- The Owner's threshold settings, one row (C3 req 5, C7 req 5). Both values
-- are edited on the dashboard and will be reset after T7.
create table public.owner_settings (
	id smallint primary key default 1 check (id = 1),
	alert_usd numeric(10, 2) not null default 60 check (alert_usd > 0),
	autopause_usd numeric(10, 2) not null default 89,
	updated_at timestamptz not null default now(),
	updated_by uuid references public.accounts (id) on delete set null,
	constraint owner_settings_alert_below_autopause check (alert_usd < autopause_usd)
);
comment on table public.owner_settings is 'The Owner''s rolling 30-day cost thresholds: alert and autopause (C3 req 5).';
insert into public.owner_settings (id) values (1);

alter table public.owner_settings enable row level security;
revoke all on table public.owner_settings from anon, authenticated;
grant select, insert, update, delete on table public.owner_settings to service_role;

-- Each tenant's dashboard status (C7 req 2): trial, active, paused, canceled,
-- retention, or none (no subscription yet). Uses the newest subscription.
-- security_invoker makes the view obey the callers' rights and RLS.
create view public.tenant_overview with (security_invoker = true) as
select
	t.id as tenant_id,
	t.account_id,
	t.status as lifecycle_status,
	t.retention_ends_at,
	s.stripe_subscription_id,
	s.status as subscription_status,
	s.plan,
	s.coupon_id,
	s.promotion_code_id,
	s.percent_off,
	s.trial_end,
	s.current_period_end,
	coalesce(s.cancel_at_period_end, false) as cancel_at_period_end,
	(p.id is not null) as paused,
	case
		when t.status = 'retention' then 'retention'
		when p.id is not null then 'paused'
		when s.status = 'trialing' then 'trial'
		when s.status in ('active', 'past_due') and s.cancel_at_period_end then 'canceled'
		when s.status in ('active', 'past_due') then 'active'
		when s.status = 'canceled' then 'canceled'
		else 'none'
	end as dashboard_status
from public.tenants t
left join lateral (
	select *
	from public.subscriptions x
	where x.tenant_id = t.id
	order by x.created_at desc, x.last_event_created_at desc
	limit 1
) s on true
left join public.pauses p on p.tenant_id = t.id and p.unpaused_at is null;

comment on view public.tenant_overview is 'Dashboard status per tenant: trial, active, paused, canceled, retention, none (C7 req 2).';
revoke all on table public.tenant_overview from anon, authenticated;
grant select on table public.tenant_overview to service_role;
