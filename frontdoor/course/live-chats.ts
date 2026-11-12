/**
 * Which of a student's chats still exist, for "Continue" on /course. A
 * student can delete a chat in the tutor, and course_leg_starts still names
 * it. One GET /api/chats on the student's own server, with its secret: the
 * read the dashboard already makes (admin/tenant-api.ts fetchSessions).
 *
 * Null when the server does not answer in time, or answers with something
 * else. Then the page links the newest start, as it did before this check.
 */
import { fetchSessions } from "../admin/tenant-api.ts";
import { errorLabel } from "../log-hygiene/filter.ts";
import type { TenantRequest } from "./endpoint.ts";

/** The ids of the chats the tenant's server lists now, or null when it did not answer. */
export type LiveChats = (tenantId: string) => Promise<ReadonlySet<string> | null>;

const LIST_TIMEOUT_MS = 5_000;

export function tenantLiveChats(tenantFetch: TenantRequest, log?: (line: string) => void, timeoutMs = LIST_TIMEOUT_MS): LiveChats {
	return async (tenantId) => {
		const signal = AbortSignal.timeout(timeoutMs);
		const read = (id: string, path: string) => tenantFetch(id, path, { headers: { Accept: "application/json" }, redirect: "manual", signal });
		// The deadline also covers starting a stopped tenant server, which the fetch's own signal does not.
		const deadline = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
		try {
			const chats = await Promise.race([fetchSessions(read, tenantId), deadline]);
			return new Set(chats.map((chat) => chat.id));
		} catch (error) {
			log?.(`course: could not list tenant ${tenantId}'s chats (${errorLabel(error)}), so Continue links the newest start`);
			return null;
		}
	};
}
