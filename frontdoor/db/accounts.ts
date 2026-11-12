/**
 * Accounts, tenants, roles, consents, retention and the day-91 delete
 * (C1 req 2, 5, 6, 7; C7 req 1 and 3; section 3 roles; D19, D25, D27, D28).
 */

import { date, dateOrNull, type Db, must, num, one, type Row, strOrNull } from "./db.ts";

export const RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type TenantStatus = "provisioning" | "ready" | "retention";
export type Role = "owner" | "staff";
export type ConsentKind = "session_text_opt_in" | "tester_written_ok";

export interface Account {
	id: string;
	clerkUserId: string;
	age18ConfirmedAt: Date;
	createdAt: Date;
}

export interface Tenant {
	id: string;
	accountId: string;
	/** Relative to the volume: tenants/<id> */
	folder: string;
	status: TenantStatus;
	stripeCustomerId: string | null;
	createdAt: Date;
	readyAt: Date | null;
	retentionEndsAt: Date | null;
}

export interface Consent {
	id: number;
	tenantId: string;
	kind: ConsentKind;
	grantedAt: Date;
	revokedAt: Date | null;
	recordedBy: string | null;
	note: string | null;
}

const ACCOUNT_COLS = "id, clerk_user_id, age_18_confirmed_at, created_at";
const TENANT_COLS = "id, account_id, folder, status, stripe_customer_id, created_at, ready_at, retention_ends_at";
const TENANT_COLS_T = TENANT_COLS.split(", ")
	.map((c) => `t.${c}`)
	.join(", ");
const CONSENT_COLS = "id, tenant_id, kind, granted_at, revoked_at, recorded_by, note";

function toAccount(r: Row): Account {
	return {
		id: String(r.id),
		clerkUserId: String(r.clerk_user_id),
		age18ConfirmedAt: date(r.age_18_confirmed_at),
		createdAt: date(r.created_at),
	};
}

export function toTenant(r: Row): Tenant {
	return {
		id: String(r.id),
		accountId: String(r.account_id),
		folder: String(r.folder),
		status: r.status as TenantStatus,
		stripeCustomerId: strOrNull(r.stripe_customer_id),
		createdAt: date(r.created_at),
		readyAt: dateOrNull(r.ready_at),
		retentionEndsAt: dateOrNull(r.retention_ends_at),
	};
}

function toConsent(r: Row): Consent {
	return {
		id: num(r.id),
		tenantId: String(r.tenant_id),
		kind: r.kind as ConsentKind,
		grantedAt: date(r.granted_at),
		revokedAt: dateOrNull(r.revoked_at),
		recordedBy: strOrNull(r.recorded_by),
		note: strOrNull(r.note),
	};
}

// ---- accounts and tenants ----

export interface NewAccount {
	clerkUserId: string;
	/** When the student ticked "I am 18 or older" (C1 req 5, D28). */
	age18ConfirmedAt: Date;
}

/** An account with no tenant: the Owner or staff. */
export async function createAccount(db: Db, input: NewAccount): Promise<Account> {
	return toAccount(
		await must(db, `insert into accounts (clerk_user_id, age_18_confirmed_at) values ($1, $2) returning ${ACCOUNT_COLS}`, [
			input.clerkUserId,
			input.age18ConfirmedAt,
		]),
	);
}

/** A tenant for an existing account. One per account. Starts as provisioning. */
export async function createTenant(db: Db, accountId: string): Promise<Tenant> {
	return toTenant(await must(db, `insert into tenants (account_id) values ($1) returning ${TENANT_COLS}`, [accountId]));
}

/** A student's account and tenant, made together in one transaction. Throws if the Clerk user already has an account. */
export async function createStudentAccount(db: Db, input: NewAccount): Promise<{ account: Account; tenant: Tenant }> {
	return db.transaction(async (tx) => {
		const account = await createAccount(tx, input);
		const tenant = await createTenant(tx, account.id);
		return { account, tenant };
	});
}

/**
 * A student's account and tenant: made on the first call, returned as they are
 * after that. The front door calls it at every sign-in. Safe to repeat and to
 * run twice at once (two tabs): the first 18+ date is kept. An account with no
 * tenant (made by createAccount) gets one.
 */
export async function ensureStudentAccount(db: Db, input: NewAccount): Promise<{ account: Account; tenant: Tenant }> {
	return db.transaction(async (tx) => {
		await tx.query("insert into accounts (clerk_user_id, age_18_confirmed_at) values ($1, $2) on conflict (clerk_user_id) do nothing", [
			input.clerkUserId,
			input.age18ConfirmedAt,
		]);
		const account = toAccount(await must(tx, `select ${ACCOUNT_COLS} from accounts where clerk_user_id = $1`, [input.clerkUserId]));
		await tx.query("insert into tenants (account_id) values ($1) on conflict (account_id) do nothing", [account.id]);
		const tenant = toTenant(await must(tx, `select ${TENANT_COLS} from tenants where account_id = $1`, [account.id]));
		return { account, tenant };
	});
}

export async function getAccountByClerkUserId(db: Db, clerkUserId: string): Promise<Account | null> {
	const r = await one(db, `select ${ACCOUNT_COLS} from accounts where clerk_user_id = $1`, [clerkUserId]);
	return r ? toAccount(r) : null;
}

export async function getTenant(db: Db, tenantId: string): Promise<Tenant | null> {
	const r = await one(db, `select ${TENANT_COLS} from tenants where id = $1`, [tenantId]);
	return r ? toTenant(r) : null;
}

export async function getTenantByAccountId(db: Db, accountId: string): Promise<Tenant | null> {
	const r = await one(db, `select ${TENANT_COLS} from tenants where account_id = $1`, [accountId]);
	return r ? toTenant(r) : null;
}

export async function getTenantByClerkUserId(db: Db, clerkUserId: string): Promise<Tenant | null> {
	const r = await one(db, `select ${TENANT_COLS_T} from tenants t join accounts a on a.id = t.account_id where a.clerk_user_id = $1`, [clerkUserId]);
	return r ? toTenant(r) : null;
}

export async function listTenants(db: Db): Promise<Tenant[]> {
	return (await db.query(`select ${TENANT_COLS} from tenants order by created_at, id`)).map(toTenant);
}

/**
 * The tenant folder exists and its server can start. Safe to repeat (the front
 * door provisions at every sign-in): only a tenant still in provisioning
 * changes. A ready tenant or one in retention comes back as it is. Throws only
 * when the tenant does not exist.
 */
export async function markTenantReady(db: Db, tenantId: string, at: Date = new Date()): Promise<Tenant> {
	const updated = await one(
		db,
		`update tenants set status = 'ready', ready_at = $2 where id = $1 and status = 'provisioning' returning ${TENANT_COLS}`,
		[tenantId, at],
	);
	if (updated) return toTenant(updated);
	// A second statement, so it reads the row as another sign-in just left it.
	const current = await one(db, `select ${TENANT_COLS} from tenants where id = $1`, [tenantId]);
	if (!current) throw new Error(`tenant ${tenantId} does not exist`);
	return toTenant(current);
}

// ---- retention and the day-91 delete (C1 req 6, D25) ----

/** The subscription ended: keep the tenant 90 days, read and export only. */
export async function startRetention(db: Db, tenantId: string, subscriptionEndedAt: Date): Promise<Tenant> {
	const ends = new Date(subscriptionEndedAt.getTime() + RETENTION_DAYS * DAY_MS);
	return toTenant(
		await must(db, `update tenants set status = 'retention', retention_ends_at = $2 where id = $1 returning ${TENANT_COLS}`, [tenantId, ends]),
	);
}

/** The student subscribed again during retention. */
export async function endRetention(db: Db, tenantId: string): Promise<Tenant> {
	return toTenant(
		await must(
			db,
			`update tenants set status = 'ready', retention_ends_at = null, ready_at = coalesce(ready_at, now()) where id = $1 returning ${TENANT_COLS}`,
			[tenantId],
		),
	);
}

/** Tenants whose 90 days are over at `now`. */
export async function listTenantsDueForDeletion(db: Db, now: Date = new Date()): Promise<Tenant[]> {
	return (
		await db.query(`select ${TENANT_COLS} from tenants where status = 'retention' and retention_ends_at <= $1 order by retention_ends_at`, [now])
	).map(toTenant);
}

/**
 * Delete the tenant's account and, through the foreign keys, every row that
 * belongs to the tenant. Trial claims and Stripe event IDs have no tenant
 * link and stay. The caller deletes the tenant folder. False if not found.
 */
export async function deleteTenantAndAccount(db: Db, tenantId: string): Promise<boolean> {
	const rows = await db.query("delete from accounts where id = (select account_id from tenants where id = $1) returning id", [tenantId]);
	return rows.length > 0;
}

// ---- roles (C7 req 1, D27) ----

/** Grant a role. Granting a role the account already has changes nothing. */
export async function grantRole(db: Db, input: { accountId: string; role: Role; grantedBy?: string }): Promise<void> {
	await db.query("insert into account_roles (account_id, role, granted_by) values ($1, $2, $3) on conflict (account_id, role) do nothing", [
		input.accountId,
		input.role,
		input.grantedBy ?? null,
	]);
}

export async function revokeRole(db: Db, accountId: string, role: Role): Promise<boolean> {
	return (await db.query("delete from account_roles where account_id = $1 and role = $2 returning role", [accountId, role])).length > 0;
}

/** The account's roles, sorted. Empty means a student. */
export async function getRoles(db: Db, accountId: string): Promise<Role[]> {
	return (await db.query<{ role: Role }>("select role from account_roles where account_id = $1 order by role", [accountId])).map((r) => r.role);
}

export async function hasRole(db: Db, accountId: string, role: Role): Promise<boolean> {
	return (await one(db, "select 1 from account_roles where account_id = $1 and role = $2", [accountId, role])) !== null;
}

/**
 * True when the tenant's account holds the owner role. The one check behind
 * the Owner's exemptions (2026-11-11): the Owner's own tenant needs no
 * subscription (billing/access.ts), never gets the plan-ended screen
 * (pause/access.ts), and is never deleted by the day-91 job
 * (retention/lifecycle.ts). It is still metered, and the cost alert and
 * autopause still apply. Staff is not exempt.
 */
export async function isOwnerTenant(db: Db, tenantId: string): Promise<boolean> {
	return (await one(db, "select 1 from tenants t join account_roles r on r.account_id = t.account_id where t.id = $1 and r.role = 'owner'", [tenantId])) !== null;
}

// ---- consents (C7 req 3, D19) ----

/** Record a consent with its date. If one is already active, return it unchanged. */
export async function grantConsent(
	db: Db,
	input: { tenantId: string; kind: ConsentKind; at?: Date; recordedBy?: string; note?: string },
): Promise<Consent> {
	return db.transaction(async (tx) => {
		const inserted = await one(
			tx,
			`insert into consents (tenant_id, kind, granted_at, recorded_by, note) values ($1, $2, $3, $4, $5)
			 on conflict (tenant_id, kind) where revoked_at is null do nothing returning ${CONSENT_COLS}`,
			[input.tenantId, input.kind, input.at ?? new Date(), input.recordedBy ?? null, input.note ?? null],
		);
		if (inserted) return toConsent(inserted);
		return toConsent(await must(tx, `select ${CONSENT_COLS} from consents where tenant_id = $1 and kind = $2 and revoked_at is null`, [input.tenantId, input.kind]));
	});
}

/** Revoke the active consent of this kind. False if none was active. */
export async function revokeConsent(db: Db, input: { tenantId: string; kind: ConsentKind; at?: Date }): Promise<boolean> {
	const rows = await db.query("update consents set revoked_at = $3 where tenant_id = $1 and kind = $2 and revoked_at is null returning id", [
		input.tenantId,
		input.kind,
		input.at ?? new Date(),
	]);
	return rows.length > 0;
}

export async function hasActiveConsent(db: Db, tenantId: string, kind: ConsentKind): Promise<boolean> {
	return (await one(db, "select 1 from consents where tenant_id = $1 and kind = $2 and revoked_at is null", [tenantId, kind])) !== null;
}

/** Every consent record for the tenant, oldest first. */
export async function listConsents(db: Db, tenantId: string): Promise<Consent[]> {
	return (await db.query(`select ${CONSENT_COLS} from consents where tenant_id = $1 order by granted_at, id`, [tenantId])).map(toConsent);
}

/** C7 req 3: session text shows only for an opted-in student or a tester with written OK. */
export async function canShowSessionText(db: Db, tenantId: string): Promise<boolean> {
	return (
		(await one(db, "select 1 from consents where tenant_id = $1 and revoked_at is null and kind in ('session_text_opt_in', 'tester_written_ok') limit 1", [
			tenantId,
		])) !== null
	);
}
