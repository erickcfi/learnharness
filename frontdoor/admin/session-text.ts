/**
 * Session text on the dashboard: consent only (P3-04, C7 req 3, D19).
 *
 * "The dashboard shows session text only for testers who gave written OK,
 * and for students who opted in." This is what backs the landing page's
 * "We see what you write only if you choose to share it", so the rule is
 * strict:
 *  - consent is read from the database on every view, just before the
 *    fetch, so a revoked consent stops the next view at once;
 *  - without an active consent the tenant server is never asked;
 *  - the text is fetched live for each view and never stored or cached;
 *  - nothing else in the front door reads session text (the non-aviation
 *    flag uses the session title and plan topics only, N7).
 */
import { canShowSessionText, type ConsentKind, type Db, grantConsent, hasActiveConsent, listConsents, revokeConsent } from "../db/index.ts";
import { fetchSessionMarkdownUnchecked, type TenantFetch } from "./tenant-api.ts";

export class SessionTextNotAllowedError extends Error {
	constructor() {
		super("This student has not shared session text.");
	}
}

export async function sessionTextAllowed(db: Db, tenantId: string): Promise<boolean> {
	return canShowSessionText(db, tenantId);
}

/** One session's text, only with an active consent. Throws SessionTextNotAllowedError otherwise. */
export async function readSessionText(deps: { db: Db; tenantFetch: TenantFetch }, tenantId: string, chatId: string): Promise<string> {
	if (!(await canShowSessionText(deps.db, tenantId))) throw new SessionTextNotAllowedError();
	return fetchSessionMarkdownUnchecked(deps.tenantFetch, tenantId, chatId);
}

export interface ConsentState {
	optedIn: boolean;
	testerWrittenOk: boolean;
	history: Awaited<ReturnType<typeof listConsents>>;
}

export async function consentState(db: Db, tenantId: string): Promise<ConsentState> {
	const [optedIn, testerWrittenOk, history] = await Promise.all([
		hasActiveConsent(db, tenantId, "session_text_opt_in"),
		hasActiveConsent(db, tenantId, "tester_written_ok"),
		listConsents(db, tenantId),
	]);
	return { optedIn, testerWrittenOk, history };
}

/** The Owner records a tester's written OK, with a note such as "signed form, 2026-11-10". */
export async function recordTesterConsent(db: Db, input: { tenantId: string; recordedBy: string; note: string; at?: Date }) {
	return grantConsent(db, { tenantId: input.tenantId, kind: "tester_written_ok", recordedBy: input.recordedBy, note: input.note, at: input.at });
}

export async function revokeTesterConsent(db: Db, tenantId: string, at?: Date): Promise<boolean> {
	return revokeConsent(db, { tenantId, kind: "tester_written_ok", at });
}

/** The student's own switch (C7 req 3: off by default, stored with its date). */
export async function setSessionTextOptIn(db: Db, tenantId: string, on: boolean, at?: Date): Promise<void> {
	const kind: ConsentKind = "session_text_opt_in";
	if (on) await grantConsent(db, { tenantId, kind, at });
	else await revokeConsent(db, { tenantId, kind, at });
}
