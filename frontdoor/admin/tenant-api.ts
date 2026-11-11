/**
 * Reading a tenant's own LearnHarness server for the dashboard (C7 req 6):
 * the session list and plan topics (GET /api/chats, GET /api/chats/:id),
 * and session text only through session-text.ts, which checks consent first
 * (GET /api/chats/:id/markdown). Read-only GETs, through upstream's API.
 *
 * Every tenant server runs all the time (X1, PD4), so the dashboard can ask
 * any of them. The parsers are the study record's (frontdoor/records), which
 * the contract tests keep in step with upstream.
 */
import { parseChatList, parseChatRecord, type UpstreamChatSummary } from "../records/upstream.ts";

/**
 * One GET to a tenant's server. The front door's wiring builds it from the
 * supervisor (supervisorTenantFetch). When W2-6 gives each tenant server its
 * own secret, the wiring adds that header here.
 */
export type TenantFetch = (tenantId: string, path: string) => Promise<Response>;

const TIMEOUT_MS = 10_000;
/** Upstream's chat ids (src/store/chats.ts). */
export const CHAT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function supervisorTenantFetch(supervisor: { ensureRunning(tenantId: string): Promise<number> }, fetchImpl: typeof fetch = fetch): TenantFetch {
	return async (tenantId, path) => {
		const port = await supervisor.ensureRunning(tenantId);
		return fetchImpl(`http://127.0.0.1:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
	};
}

export class TenantReadError extends Error {
	/** The tenant server's HTTP status, when it answered. 404 on a chat path: no such chat. */
	readonly status: number | null;
	constructor(message: string, status: number | null = null) {
		super(message);
		this.status = status;
	}
}

async function getJson(tenantFetch: TenantFetch, tenantId: string, path: string): Promise<unknown> {
	const res = await tenantFetch(tenantId, path);
	if (!res.ok) throw new TenantReadError(`tenant server answered ${res.status}`, res.status);
	return res.json();
}

/** The tenant's sessions (titles, dates, phase), as upstream lists them. */
export async function fetchSessions(tenantFetch: TenantFetch, tenantId: string): Promise<UpstreamChatSummary[]> {
	return parseChatList(await getJson(tenantFetch, tenantId, "/api/chats"));
}

/**
 * One session's title and plan topic titles. Upstream's answer also holds
 * the messages; they are dropped here and never stored, shown or sent on.
 */
export async function fetchSessionTopics(tenantFetch: TenantFetch, tenantId: string, chatId: string): Promise<{ title: string; topics: string[] }> {
	if (!CHAT_ID.test(chatId)) throw new TenantReadError("not a chat id");
	const record = parseChatRecord(await getJson(tenantFetch, tenantId, `/api/chats/${encodeURIComponent(chatId)}`));
	return { title: record.title, topics: (record.tree?.nodes ?? []).map((n) => n.title) };
}

/** Session text as markdown. Only session-text.ts calls this, after the consent check. */
export async function fetchSessionMarkdownUnchecked(tenantFetch: TenantFetch, tenantId: string, chatId: string): Promise<string> {
	if (!CHAT_ID.test(chatId)) throw new TenantReadError("not a chat id");
	const res = await tenantFetch(tenantId, `/api/chats/${encodeURIComponent(chatId)}/markdown`);
	if (!res.ok) throw new TenantReadError(`tenant server answered ${res.status}`, res.status);
	return res.text();
}
