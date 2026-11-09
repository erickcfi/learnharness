/**
 * P3-02: study time and session counts at the front door (PD1, C7 req 6).
 *
 * PD1: study time is active time, "the tab is visible, and the student
 * acted in the last 5 minutes". The tutor page's heartbeat script checks
 * both and posts the chat it is on; the front door credits at most real time
 * per student and stores it per upstream chat id in study_time.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import {
	ACTIVITY_PATH,
	ACTIVITY_SCRIPT,
	ACTIVITY_SCRIPT_PATH,
	activeSecondsBySession,
	chatIdFromPath,
	createActivityCredit,
	createStudyTimeEndpoint,
	createStudyTimeRecorder,
	HEARTBEAT_SECONDS,
	listEndedSessions,
	listSessionStudy,
	studyByTenant,
} from "../frontdoor/study-time/index.ts";
import { InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";
import { buildStudyRecord } from "../frontdoor/records/index.ts";

const AGE = new Date("2026-11-01T12:00:00Z");
const T0 = Date.parse("2026-11-08T10:00:00Z");
let t: TestDb;
let n = 0;
async function tenant(): Promise<string> {
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: `user_st_${++n}`, age18ConfirmedAt: AGE });
	return tenant.id;
}

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("PD1 credit: heartbeats earn at most real time", () => {
	it("the first beat earns one interval, later beats earn the time since the last", () => {
		const c = createActivityCredit({ intervalSeconds: 30 });
		assert.equal(c.credit("a", T0), 30);
		assert.equal(c.credit("a", T0 + 30_000), 30);
		assert.equal(c.credit("a", T0 + 45_000), 15);
	});

	it("two tabs beating together never count twice", () => {
		const c = createActivityCredit({ intervalSeconds: 30 });
		let total = 0;
		for (let s = 0; s < 600; s += 30) {
			total += c.credit("a", T0 + s * 1000); // tab 1
			total += c.credit("a", T0 + (s + 7) * 1000); // tab 2, 7 s later
		}
		// 20 beats of 30 s from tab 1's clock, plus the first interval: about 10 minutes, never 20.
		assert.ok(total <= 600 + 30, `got ${total}`);
		assert.ok(total >= 600 - 30, `got ${total}`);
	});

	it("a script beating every second still earns only real time", () => {
		const c = createActivityCredit({ intervalSeconds: 30 });
		let total = 0;
		for (let s = 0; s <= 120; s += 1) total += c.credit("a", T0 + s * 1000);
		assert.ok(total <= 150, `got ${total}`);
	});

	it("after a pause the next beat earns one interval, not the whole pause", () => {
		const c = createActivityCredit({ intervalSeconds: 30 });
		c.credit("a", T0);
		assert.equal(c.credit("a", T0 + 3600_000), 30);
	});

	it("students do not share a clock", () => {
		const c = createActivityCredit({ intervalSeconds: 30 });
		assert.equal(c.credit("a", T0), 30);
		assert.equal(c.credit("b", T0 + 1000), 30);
	});
});

describe("chat id from the page path", () => {
	it("reads upstream chat pages", () => {
		assert.equal(chatIdFromPath("/chat/chat_mh5x2k_1a2b3c4d"), "chat_mh5x2k_1a2b3c4d");
		assert.equal(chatIdFromPath("/chat/chat_mh5x2k_1a2b3c4d/"), "chat_mh5x2k_1a2b3c4d");
	});
	it("anything else is outside any chat", () => {
		for (const p of ["/", "/chat/new", "/settings", "/chat/", "/chat/a%2Fb", "/chat/../x", "/chat/" + "x".repeat(200), 42, null, undefined]) {
			assert.equal(chatIdFromPath(p), null, String(p));
		}
	});
});

describe("the heartbeat script", () => {
	it("beats only while the tab is visible and the student acted in the last 5 minutes", () => {
		assert.match(ACTIVITY_SCRIPT, /document\.visibilityState !== "visible"/);
		assert.match(ACTIVITY_SCRIPT, /const WINDOW_MS = 300000;/);
		assert.match(ACTIVITY_SCRIPT, new RegExp(`const BEAT_MS = ${HEARTBEAT_SECONDS * 1000};`));
		for (const input of ["keydown", "pointerdown", "touchstart", "wheel", "scroll"]) assert.ok(ACTIVITY_SCRIPT.includes(`"${input}"`), input);
	});
	it("sends only the page path, never page text", () => {
		assert.match(ACTIVITY_SCRIPT, /JSON\.stringify\(\{ path: location\.pathname \}\)/);
		assert.doesNotMatch(ACTIVITY_SCRIPT, /innerText|textContent|innerHTML|document\.title/);
	});
});

describe("the recorder stores study time per upstream chat id", () => {
	it("writes each credited beat to study_time with its chat id", async () => {
		const tid = await tenant();
		let clock = T0;
		const rec = createStudyTimeRecorder({ db: t.db, now: () => clock });
		for (let i = 0; i < 4; i++) {
			await rec.beat(tid, "chat_a");
			clock += 30_000;
		}
		for (let i = 0; i < 2; i++) {
			await rec.beat(tid, "chat_b");
			clock += 30_000;
		}
		await rec.beat(tid, null);
		assert.deepEqual(await activeSecondsBySession(t.db, tid), { chat_a: 120, chat_b: 60 });
		const stretches = await dbm.listStudyStretches(t.db, tid);
		assert.deepEqual(stretches.map((s) => [s.chatId, s.activeSeconds]), [["chat_a", 120], ["chat_b", 60], [null, 30]]);
	});

	it("keeps time that could not be written and adds it to the next write", async () => {
		const tid = await tenant();
		let clock = T0;
		let down = true;
		const flaky: dbm.Db = {
			query: (text, params) => (down ? Promise.reject(new Error("connection refused")) : t.db.query(text, params)),
			transaction: (fn) => (down ? Promise.reject(new Error("connection refused")) : t.db.transaction(fn)),
		};
		const logs: string[] = [];
		const rec = createStudyTimeRecorder({ db: flaky, now: () => clock, log: (l) => logs.push(l) });
		assert.equal(await rec.beat(tid, "chat_a"), 0);
		clock += 30_000;
		assert.equal(await rec.beat(tid, "chat_a"), 0);
		assert.equal(rec.pendingSeconds(), 60);
		down = false;
		clock += 30_000;
		assert.equal(await rec.beat(tid, "chat_a"), 90);
		assert.equal(rec.pendingSeconds(), 0);
		assert.deepEqual(await activeSecondsBySession(t.db, tid), { chat_a: 90 });
		assert.ok(logs.length === 2 && logs.every((l) => !l.includes("@")));
	});

	it("drops time the database refuses for good (a deleted tenant)", async () => {
		const rec = createStudyTimeRecorder({ db: t.db, now: () => T0 });
		assert.equal(await rec.beat("00000000-0000-4000-8000-000000000000", "chat_a"), 0);
		assert.equal(rec.pendingSeconds(), 0);
	});
});

describe("study time read back", () => {
	it("gives the record builder its activeSecondsBySession", async () => {
		const tid = await tenant();
		let clock = T0;
		const rec = createStudyTimeRecorder({ db: t.db, now: () => clock });
		for (let i = 0; i < 10; i++) {
			await rec.beat(tid, "chat_metar");
			clock += 30_000;
		}
		const bySession = await activeSecondsBySession(t.db, tid);
		const record = buildStudyRecord(
			{
				chats: [{ id: "chat_metar", title: "Decoding a METAR", createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), kind: "teach", messageCount: 4, phase: "teach" }],
				records: { chat_metar: { id: "chat_metar", title: "Decoding a METAR", createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), messages: [] } },
				graph: { propositions: [], sessions: {}, fileSources: {} },
			},
			{ studentName: "Test Student", printedAt: new Date(T0 + 3600_000), timeZone: "America/Los_Angeles", activeSecondsBySession: bySession },
		);
		assert.equal(record.sessions[0]?.activeSeconds, 300);
	});

	it("counts study time and sessions per tenant, and lists sessions newest first", async () => {
		const tid = await tenant();
		let clock = T0;
		const rec = createStudyTimeRecorder({ db: t.db, now: () => clock });
		await rec.beat(tid, "chat_1");
		clock += 3600_000;
		await rec.beat(tid, "chat_2");
		const byTenant = await studyByTenant(t.db);
		assert.deepEqual(byTenant.get(tid), { tenantId: tid, activeSeconds: 60, sessions: 2 });
		const sessions = await listSessionStudy(t.db, tid);
		assert.deepEqual(sessions.map((s) => s.chatId), ["chat_2", "chat_1"]);
	});

	it("a session has ended after 30 minutes without active time, and is listed until labeled", async () => {
		const tid = await tenant();
		const rec = createStudyTimeRecorder({ db: t.db, now: () => T0 });
		await rec.beat(tid, "chat_end");
		const at = (min: number) => new Date(T0 + min * 60_000);
		const mine = async (now: Date, unlabeledOnly = true) =>
			(await listEndedSessions(t.db, { now, unlabeledOnly })).filter((s) => s.tenantId === tid).map((s) => s.chatId);
		assert.deepEqual(await mine(at(29)), []);
		assert.deepEqual(await mine(at(31)), ["chat_end"]);
		await dbm.saveTopicLabel(t.db, { tenantId: tid, chatId: "chat_end", topic: "x", isAviation: true, model: "m", at: at(31) });
		assert.deepEqual(await mine(at(40)), []);
		assert.deepEqual(await mine(at(40), false), ["chat_end"]);
	});
});

describe("the gateway route (after the login check)", () => {
	const SECRET = new TextEncoder().encode("study-time-test-secret-0123456789abcdefgh");
	let gateway: Server;
	let tenantServer: Server;
	let base = "";
	let tenantId = "";
	let clock = T0;
	const tenantHits: string[] = [];

	before(async () => {
		const accounts = new InMemoryAccountStore();
		await accounts.confirmAge("user_hb", AGE);
		// The in-memory store makes its own ids; the db needs a real tenant row.
		tenantId = await tenant();
		const realGet = accounts.get.bind(accounts);
		accounts.get = async (userId) => {
			const a = await realGet(userId);
			return a ? { ...a, tenantId } : a;
		};
		tenantServer = createServer((req, res) => {
			tenantHits.push(req.url ?? "");
			res.end("tenant");
		});
		await new Promise<void>((r) => tenantServer.listen(0, "127.0.0.1", r));
		const tenantPort = (tenantServer.address() as AddressInfo).port;
		gateway = createServer(
			createGateway({
				accounts,
				clerk: { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true },
				supervisor: { ensureRunning: async () => tenantPort },
				provision: async () => {},
				sessionSecret: SECRET,
				secureCookies: false,
				trustForwardedHeaders: false,
				frontDoorApp: (_req, res) => res.end("page"),
				now: () => clock,
				studentRoutes: createStudyTimeEndpoint({ recorder: createStudyTimeRecorder({ db: t.db, now: () => clock }) }),
			}),
		);
		await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
	});
	after(async () => {
		await new Promise((r) => gateway.close(r));
		await new Promise((r) => tenantServer.close(r));
	});
	beforeEach(() => {
		tenantHits.length = 0;
	});

	const cookie = async () => `${SESSION_COOKIE}=${await signSession({ userId: "user_hb", sessionId: "s", tenantId, checkedAt: clock }, SECRET, clock)}`;
	const beat = async (body: string, headers: Record<string, string> = {}) =>
		fetch(`${base}${ACTIVITY_PATH}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: await cookie(), ...headers }, body });

	it("without a login a heartbeat gets 401 and stores nothing", async () => {
		const res = await fetch(`${base}${ACTIVITY_PATH}`, { method: "POST", body: '{"path":"/chat/chat_x"}' });
		assert.equal(res.status, 401);
		assert.deepEqual(await activeSecondsBySession(t.db, tenantId), {});
	});

	it("a heartbeat is stored for the login's tenant and chat, and never reaches the tenant server", async () => {
		const res = await beat('{"path":"/chat/chat_gw_1"}');
		assert.equal(res.status, 204);
		clock += 30_000;
		assert.equal((await beat('{"path":"/chat/chat_gw_1"}')).status, 204);
		assert.deepEqual(await activeSecondsBySession(t.db, tenantId), { chat_gw_1: 60 });
		assert.deepEqual(tenantHits, []);
	});

	it("serves the script to a signed-in page", async () => {
		const res = await fetch(`${base}${ACTIVITY_SCRIPT_PATH}`, { headers: { Cookie: await cookie() } });
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /javascript/);
		assert.equal(await res.text(), ACTIVITY_SCRIPT);
		assert.deepEqual(tenantHits, []);
	});

	it("refuses bad bodies, other methods and cross-site posts", async () => {
		assert.equal((await beat("not json")).status, 400);
		assert.equal((await beat(JSON.stringify({ path: "x".repeat(5000) }))).status, 413);
		assert.equal((await beat('{"path":"/chat/chat_x"}', { "Sec-Fetch-Site": "cross-site" })).status, 403);
		const get = await fetch(`${base}${ACTIVITY_PATH}`, { headers: { Cookie: await cookie() } });
		assert.equal(get.status, 405);
	});

	it("other paths still pass through to the tenant", async () => {
		const res = await fetch(`${base}/api/chats`, { headers: { Cookie: await cookie() } });
		assert.equal(await res.text(), "tenant");
		assert.deepEqual(tenantHits, ["/api/chats"]);
	});
});
