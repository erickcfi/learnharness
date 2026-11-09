/**
 * Making the Owner (P3-01, D27): a one-time step, never hard-coded.
 * The Owner signs in once like any student (that makes the account), then
 * this grants the account the owner role. See README.md in this folder.
 */
import { type Db, getAccountByClerkUserId, getRoles, grantRole, type Role } from "../db/index.ts";

export type GrantResult = { ok: true; accountId: string; alreadyOwner: boolean } | { ok: false; reason: "no-account" | "bad-id" };

/** Clerk user ids look like user_2abc...; anything else is refused. */
export const CLERK_USER_ID = /^user_[A-Za-z0-9]{8,64}$/;

export async function grantOwnerByClerkId(db: Db, clerkUserId: string): Promise<GrantResult> {
	if (!CLERK_USER_ID.test(clerkUserId)) return { ok: false, reason: "bad-id" };
	const account = await getAccountByClerkUserId(db, clerkUserId);
	if (!account) return { ok: false, reason: "no-account" };
	const before = await getRoles(db, account.id);
	await grantRole(db, { accountId: account.id, role: "owner" });
	return { ok: true, accountId: account.id, alreadyOwner: before.includes("owner") };
}

/** Accounts holding a role, for checking the step worked. */
export async function listRoleHolders(db: Db): Promise<Array<{ clerkUserId: string; role: Role; grantedAt: Date }>> {
	const rows = await db.query(
		`select a.clerk_user_id, r.role, r.granted_at from account_roles r join accounts a on a.id = r.account_id order by r.granted_at, a.clerk_user_id`,
	);
	return rows.map((r) => ({ clerkUserId: String(r.clerk_user_id), role: r.role as Role, grantedAt: r.granted_at instanceof Date ? r.granted_at : new Date(String(r.granted_at)) }));
}
