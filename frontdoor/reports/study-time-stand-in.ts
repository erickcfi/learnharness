/**
 * Stand-in for frontdoor/study-time's "ended sittings" export (w2-dashboard),
 * until the master wires the real one at merge. Same rule: activity in any
 * chat, no gap over 30 minutes, ended after 30 idle minutes.
 */
import type { Db } from "../db/db.ts";
import { type EndedSittingsSource, endedOnly, groupSittings, SESSION_IDLE_MINUTES, stretchWindowStart } from "./sittings.ts";
import { stretchesActiveSince } from "./store.ts";

export function studyTimeSittings(db: Db, idleMinutes = SESSION_IDLE_MINUTES): EndedSittingsSource {
	return async ({ tenantId, endedSince, now }) => {
		const stretches = await stretchesActiveSince(db, tenantId, stretchWindowStart(endedSince));
		return endedOnly(groupSittings(stretches, idleMinutes), now, idleMinutes)
			.filter((s) => s.endedAt >= endedSince)
			.map((s) => ({ tenantId, sittingStartedAt: s.startedAt, endedAt: s.endedAt, chats: s.chats }));
	};
}
