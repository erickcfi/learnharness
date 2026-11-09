/**
 * The front door's own signed cookies (Owner, 2026-11-08).
 *
 * fd_session: the login. Clerk's own token lasts 60 seconds and only Clerk's
 * page script renews it, which LearnHarness pages do not load. So after a
 * Clerk login the front door issues this cookie, and re-checks the Clerk
 * session every SESSION_RECHECK_MS while the student is active.
 *
 * fd_age: the 18+ tick, carried from the sign-up page to the first login.
 *
 * Both are JWTs signed with HMAC-SHA256 (HS256) and FRONTDOOR_SESSION_SECRET.
 * Each has its own audience, so one can never pass as the other.
 */
import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "fd_session";
export const AGE_COOKIE = "fd_age";
export const SESSION_RECHECK_MS = 5 * 60_000;
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 3600;
export const AGE_MAX_AGE_SECONDS = 3600;

const SESSION_AUDIENCE = "frontdoor-session";
const AGE_AUDIENCE = "frontdoor-age";
const ALGORITHMS = ["HS256"];

export interface FrontDoorSession {
	/** The Clerk user ID. */
	userId: string;
	/** The Clerk session ID, for the re-check. */
	sessionId: string;
	tenantId: string;
	/** When the Clerk session was last checked (ms since epoch). */
	checkedAt: number;
}

const seconds = (ms: number) => Math.floor(ms / 1000);

/** FRONTDOOR_SESSION_SECRET as bytes. Used by the custom server and the front door's pages. */
export function sessionSecretFrom(raw: string | undefined): Uint8Array {
	if (!raw) throw new Error("FRONTDOOR_SESSION_SECRET is not set.");
	if (raw.length < 32) throw new Error("FRONTDOOR_SESSION_SECRET must be at least 32 characters.");
	return new TextEncoder().encode(raw);
}

export async function signSession(session: FrontDoorSession, secret: Uint8Array, now: number): Promise<string> {
	return new SignJWT({ sid: session.sessionId, tid: session.tenantId, chk: session.checkedAt })
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(session.userId)
		.setAudience(SESSION_AUDIENCE)
		.setIssuedAt(seconds(now))
		.setExpirationTime(seconds(now) + SESSION_MAX_AGE_SECONDS)
		.sign(secret);
}

export async function verifySession(token: string | undefined, secret: Uint8Array, now: number): Promise<FrontDoorSession | null> {
	if (!token) return null;
	try {
		const { payload } = await jwtVerify(token, secret, { algorithms: ALGORITHMS, audience: SESSION_AUDIENCE, currentDate: new Date(now) });
		const { sub, sid, tid, chk } = payload;
		if (typeof sub !== "string" || typeof sid !== "string" || typeof tid !== "string" || typeof chk !== "number") return null;
		return { userId: sub, sessionId: sid, tenantId: tid, checkedAt: chk };
	} catch {
		return null;
	}
}

export async function signAgeConfirmation(confirmedAt: number, secret: Uint8Array): Promise<string> {
	return new SignJWT({ at: confirmedAt })
		.setProtectedHeader({ alg: "HS256" })
		.setAudience(AGE_AUDIENCE)
		.setIssuedAt(seconds(confirmedAt))
		.setExpirationTime(seconds(confirmedAt) + AGE_MAX_AGE_SECONDS)
		.sign(secret);
}

/** The time of the tick, or null when the cookie is missing, wrong, or expired. */
export async function verifyAgeConfirmation(token: string | undefined, secret: Uint8Array, now: number): Promise<number | null> {
	if (!token) return null;
	try {
		const { payload } = await jwtVerify(token, secret, { algorithms: ALGORITHMS, audience: AGE_AUDIENCE, currentDate: new Date(now) });
		return typeof payload.at === "number" ? payload.at : null;
	} catch {
		return null;
	}
}
