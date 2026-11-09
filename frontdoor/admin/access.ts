/**
 * Who is asking for /admin (P3-01, C7 req 1). The dashboard uses the same
 * login as the tutor: the front door's fd_session cookie, re-checked with
 * Clerk every 5 minutes (gateway/session.ts). The role comes from the
 * tutor's database on every request, so a role taken away stops working at
 * once.
 */
import type { ClerkGateway } from "../gateway/auth.ts";
import { parseCookies } from "../gateway/cookies.ts";
import { SESSION_COOKIE, SESSION_RECHECK_MS, signSession, verifySession, type FrontDoorSession } from "../gateway/session.ts";
import { type Db, getAccountByClerkUserId, getRoles, type Role } from "../db/index.ts";
import { can, type Permission } from "./roles.ts";

export interface AdminIdentity {
	accountId: string;
	clerkUserId: string;
	roles: Role[];
}

export type AdminAccess =
	| { kind: "signed-out" }
	| { kind: "forbidden" }
	/** `renewedSession` is a fresh fd_session token when the Clerk re-check ran. */
	| { kind: "allowed"; identity: AdminIdentity; renewedSession?: string };

export interface AccessDeps {
	db: Db;
	sessionSecret: Uint8Array;
	/** Null skips the 5-minute Clerk re-check: only for the pages' own second check, after the gateway's. */
	clerk: Pick<ClerkGateway, "isSessionActive"> | null;
	now?: () => number;
}

/** Thrown when Clerk cannot be reached for the re-check. The route answers 503. */
export class LoginCheckUnavailableError extends Error {}

/** The login and role behind a Cookie header, for one permission. */
export async function resolveAdminAccess(deps: AccessDeps, cookieHeader: string | undefined, permission: Permission = "dashboard.view"): Promise<AdminAccess> {
	const now = deps.now ? deps.now() : Date.now();
	const session = await verifySession(parseCookies(cookieHeader).get(SESSION_COOKIE), deps.sessionSecret, now);
	if (!session) return { kind: "signed-out" };
	let renewed: FrontDoorSession | undefined;
	if (deps.clerk && now - session.checkedAt > SESSION_RECHECK_MS) {
		let active: boolean;
		try {
			active = await deps.clerk.isSessionActive(session.sessionId);
		} catch (error) {
			throw new LoginCheckUnavailableError((error as Error).message);
		}
		if (!active) return { kind: "signed-out" };
		renewed = { ...session, checkedAt: now };
	}
	const account = await getAccountByClerkUserId(deps.db, session.userId);
	if (!account) return { kind: "forbidden" };
	const roles = await getRoles(deps.db, account.id);
	if (!can(roles, permission)) return { kind: "forbidden" };
	const identity = { accountId: account.id, clerkUserId: account.clerkUserId, roles };
	if (!renewed) return { kind: "allowed", identity };
	return { kind: "allowed", identity, renewedSession: await signSession(renewed, deps.sessionSecret, now) };
}
