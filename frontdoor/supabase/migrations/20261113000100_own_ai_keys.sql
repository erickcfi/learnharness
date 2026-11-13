-- North Aero Ground Tutor: a student's own Anthropic API key (master decision, 2026-11-13).
-- Record: docs/decisions/2026-11-13-own-ai-key.md. Code: frontdoor/own-key.
--
-- A student may paste their own Anthropic API key on /account/ai-key. The
-- front door keeps it here, encrypted with AES-256-GCM. The encryption
-- secret is the Railway variable LH_OWN_KEY_SECRET, which never enters the
-- database, so a copy of this table alone cannot be read. The key never
-- reaches the student's tenant server or the volume: the meter decrypts it
-- for each call and sends the call with it instead of North Aero's key.
-- Only the last 4 characters are kept in clear, to show on the page.
--
-- model_usage.own_key marks a call sent with the student's own key. Its cost
-- is the student's, so it does not count toward the automatic pause, and
-- the dashboard shows it apart from North Aero's cost.
--
-- Apply this file before deploying the code that uses it. The old code
-- works with it (a new table, and a new column with a default).
--
-- Same lockdown as every table (frontdoor/db/README.md): row-level security
-- on with no allow rules, no rights for anon and authenticated, and only the
-- server (service_role) reads and writes. Deleting a tenant removes its key.

create table public.own_ai_keys (
	tenant_id uuid primary key references public.tenants (id) on delete cascade,
	provider text not null default 'anthropic' check (provider = 'anthropic'),
	-- AES-256-GCM: the encrypted key, its 12-byte nonce and 16-byte tag.
	ciphertext bytea not null check (octet_length(ciphertext) between 20 and 512),
	iv bytea not null check (octet_length(iv) = 12),
	auth_tag bytea not null check (octet_length(auth_tag) = 16),
	-- The key's last 4 characters, the only part ever shown.
	last4 text not null check (char_length(last4) = 4),
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	constraint own_ai_keys_updated_after_created check (updated_at >= created_at)
);
comment on table public.own_ai_keys is 'A student''s own Anthropic API key, encrypted (AES-256-GCM, secret outside the database). Last 4 characters in clear.';

alter table public.own_ai_keys enable row level security;
revoke all on table public.own_ai_keys from anon, authenticated;
grant select, insert, update, delete on table public.own_ai_keys to service_role;

-- True when the call went out with the student's own key: the student pays
-- Anthropic for it, not North Aero.
alter table public.model_usage add column own_key boolean not null default false;
comment on column public.model_usage.own_key is 'True when the call used the student''s own Anthropic key. Not counted toward the automatic pause.';
