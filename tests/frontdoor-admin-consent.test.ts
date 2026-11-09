/**
 * P3-04: topics, consent and session text (C7 req 3 and 6, D19; C7
 * acceptance test "With consent off, no session text appears for that
 * tenant").
 *
 * This backs the landing page's "We see what you write only if you choose
 * to share it". Without an active consent (the student's opt-in, or a
 * tester's written OK recorded by the Owner) no session text leaves the
 * tenant's server for the dashboard, and none appears in any dashboard
 * answer.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { getAdminRuntime } from "../frontdoor/admin/registry.ts";
import { setSessionTextOptIn } from "../frontdoor/admin/session-text.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { type Fixture, startFixture } from "./frontdoor-admin-fixture.ts";

const SECRET_TEXT = "my private note about my checkride nerves";
let f: Fixture;
let s: { tenantId: string; clerkUserId: string };
let other: { tenantId: string; clerkUserId: string };
let owner: string;

before(async () => {
	f = await startFixture();
	s = await f.student("consent_s");
	other = await f.student("consent_other");
	owner = await f.cookie(f.owner.clerkUserId);
	f.chats.set(s.tenantId, [{ id: "chat_metar_1", title: "Decoding a METAR", topics: ["Wind", "Visibility"], markdown: `# Decoding a METAR\n\n${SECRET_TEXT}` }]);
	f.chats.set(other.tenantId, [{ id: "chat_other_1", title: "Airspace", topics: ["Class B"], markdown: "other student's text" }]);
});
after(async () => {
	await f.close();
});
beforeEach(() => {
	f.tenantHits.length = 0;
});

const textUrl = (tenantId: string, chatId: string) => `${f.base}/admin/api/tenants/${tenantId}/sessions/${chatId}/text`;
const markdownAsked = () => f.tenantHits.filter(([, p]) => p.endsWith("/markdown"));

async function everyDashboardAnswer(): Promise<string> {
	const parts = await Promise.all(
		[`/admin/api/overview?period=all`, `/admin/api/tenants/${s.tenantId}?period=all`, `/admin/api/tenants/${other.tenantId}`].map(async (p) =>
			(await fetch(`${f.base}${p}`, { headers: { Cookie: owner } })).text(),
		),
	);
	return parts.join("\n");
}

describe("consent off (the default)", () => {
	it("no consent exists for a new student", async () => {
		assert.equal(await dbm.canShowSessionText(f.db, s.tenantId), false);
		assert.deepEqual(await dbm.listConsents(f.db, s.tenantId), []);
	});

	it("the session text route refuses, and the tenant server is never asked for text", async () => {
		const res = await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } });
		assert.equal(res.status, 403);
		assert.doesNotMatch(await res.text(), /checkride nerves/);
		assert.deepEqual(markdownAsked(), []);
	});

	it("the pages' runtime refuses too", async () => {
		const rt = getAdminRuntime();
		assert.ok(rt);
		assert.deepEqual(await rt.sessionText(s.tenantId, "chat_metar_1"), { allowed: false });
		assert.deepEqual(markdownAsked(), []);
	});

	it("topics show, session text does not, anywhere on the dashboard", async () => {
		const detail = (await (await fetch(`${f.base}/admin/api/tenants/${s.tenantId}`, { headers: { Cookie: owner } })).json()) as {
			canShowText: boolean;
			sessions: Array<{ title: string; topics: string[] }>;
		};
		assert.equal(detail.canShowText, false);
		assert.equal(detail.sessions[0]?.title, "Decoding a METAR");
		assert.deepEqual(detail.sessions[0]?.topics, ["Wind", "Visibility"]);
		assert.doesNotMatch(await everyDashboardAnswer(), /checkride nerves|other student's text/);
		assert.deepEqual(markdownAsked(), []);
	});
});

describe("the student's opt-in", () => {
	it("shows the text while on, with its date stored", async () => {
		await setSessionTextOptIn(f.db, s.tenantId, true, new Date(f.clock.now));
		const res = await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } });
		assert.equal(res.status, 200);
		assert.match(await res.text(), /checkride nerves/);
		const [consent] = await dbm.listConsents(f.db, s.tenantId);
		assert.equal(consent?.kind, "session_text_opt_in");
		assert.equal(consent?.grantedAt.toISOString(), new Date(f.clock.now).toISOString());
	});

	it("does not open another student's text", async () => {
		const res = await fetch(textUrl(other.tenantId, "chat_other_1"), { headers: { Cookie: owner } });
		assert.equal(res.status, 403);
		assert.deepEqual(markdownAsked(), []);
	});

	it("turning it off stops the very next view", async () => {
		await setSessionTextOptIn(f.db, s.tenantId, false, new Date(f.clock.now + 1000));
		assert.equal((await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } })).status, 403);
		const rt = getAdminRuntime();
		assert.deepEqual(await rt?.sessionText(s.tenantId, "chat_metar_1"), { allowed: false });
		assert.deepEqual(markdownAsked(), []);
		const history = await dbm.listConsents(f.db, s.tenantId);
		assert.ok(history[0]?.revokedAt, "the revoke date is kept");
	});
});

describe("a tester's written OK, recorded by the Owner", () => {
	const post = (p: string, body: string) =>
		fetch(`${f.base}${p}`, { method: "POST", headers: { Cookie: owner, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", ...f.origin() }, body });

	it("needs a note saying where the OK is kept", async () => {
		const res = await post(`/admin/api/tenants/${s.tenantId}/consents/tester`, "note=");
		assert.equal(res.status, 400);
		assert.equal(await dbm.hasActiveConsent(f.db, s.tenantId, "tester_written_ok"), false);
	});

	it("opens the text, and revoking closes it", async () => {
		assert.equal((await post(`/admin/api/tenants/${s.tenantId}/consents/tester`, "note=signed+form%2C+2026-11-10")).status, 200);
		const c = (await dbm.listConsents(f.db, s.tenantId)).find((x) => x.kind === "tester_written_ok");
		assert.equal(c?.note, "signed form, 2026-11-10");
		assert.equal(c?.recordedBy, f.owner.accountId);
		assert.equal((await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } })).status, 200);
		assert.equal((await post(`/admin/api/tenants/${s.tenantId}/consents/tester/revoke`, "")).status, 200);
		assert.equal((await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } })).status, 403);
	});

	it("a student cannot record or read anything here", async () => {
		const cookie = await f.cookie(s.clerkUserId, { tenantId: s.tenantId });
		const res = await fetch(`${f.base}/admin/api/tenants/${s.tenantId}/consents/tester`, {
			method: "POST",
			headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded", ...f.origin() },
			body: "note=I+agree",
		});
		assert.equal(res.status, 403);
		assert.equal(await dbm.hasActiveConsent(f.db, s.tenantId, "tester_written_ok"), false);
	});
});

describe("the student's own switch (/account/sharing)", () => {
	const flip = async (cookie: string | null, body: string, extra: Record<string, string> = {}) =>
		fetch(`${f.base}/_frontdoor/sharing`, {
			method: "POST",
			redirect: "manual",
			headers: { ...(cookie ? { Cookie: cookie } : {}), "Content-Type": "application/x-www-form-urlencoded", ...f.origin(), ...extra },
			body,
		});

	it("needs a login, and refuses another site's form", async () => {
		assert.equal((await flip(null, "share=on")).status, 401);
		const cookie = await f.cookie(s.clerkUserId, { tenantId: s.tenantId });
		assert.equal((await flip(cookie, "share=on", { Origin: "https://evil.example" })).status, 403);
		assert.equal(await dbm.hasActiveConsent(f.db, s.tenantId, "session_text_opt_in"), false);
	});

	it("turns on and off only the signed-in student's own consent, with dates", async () => {
		const cookie = await f.cookie(s.clerkUserId, { tenantId: s.tenantId });
		const on = await flip(cookie, "share=on");
		assert.equal(on.status, 303);
		assert.equal(on.headers.get("location"), "/account/sharing?saved=on");
		assert.equal(await dbm.hasActiveConsent(f.db, s.tenantId, "session_text_opt_in"), true);
		assert.equal(await dbm.hasActiveConsent(f.db, other.tenantId, "session_text_opt_in"), false);
		const rt = getAdminRuntime();
		assert.equal((await rt?.studentSharing(cookie))?.optedIn, true);
		assert.equal((await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } })).status, 200);

		const off = await flip(cookie, "");
		assert.equal(off.headers.get("location"), "/account/sharing?saved=off");
		assert.equal((await rt?.studentSharing(cookie))?.optedIn, false);
		assert.equal((await fetch(textUrl(s.tenantId, "chat_metar_1"), { headers: { Cookie: owner } })).status, 403);
		assert.equal(await rt?.studentSharing(undefined), null);
	});
});

describe("bad ids", () => {
	it("are refused before anything is read", async () => {
		await setSessionTextOptIn(f.db, s.tenantId, true);
		for (const chat of ["..%2F..%2Fapi%2Fkeys", "chat%20x", "a".repeat(200)]) {
			const res = await fetch(`${f.base}/admin/api/tenants/${s.tenantId}/sessions/${chat}/text`, { headers: { Cookie: owner } });
			assert.equal(res.status, 404, chat);
		}
		assert.deepEqual(markdownAsked(), []);
		await setSessionTextOptIn(f.db, s.tenantId, false);
	});
});
