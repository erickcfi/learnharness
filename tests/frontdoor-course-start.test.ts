/**
 * Starting a course lesson through the gateway (master, 2026-11-11):
 * /course needs the front door's login like a tutor page; "Start lesson"
 * opens a new chat on the student's own tutor server with upstream's own
 * POST /api/chats, records a Started mark, and lands on /chat/<id>?prompt=
 * with the Leg's first message. The marks work with the table and without
 * it (migration not applied yet). Invented course data only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { databaseStartBlock } from "../frontdoor/course/blocks.ts";
import { type Course, createCourse } from "../frontdoor/course/index.ts";
import { COURSE_FILE_NAME, findLeg } from "../frontdoor/course/file.ts";
import { firstMessage } from "../frontdoor/course/first-message.ts";
import { legStartMarks, MISSING_TABLE_LINE } from "../frontdoor/course/marks.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import type { ClerkGateway } from "../frontdoor/gateway/auth.ts";
import { createGateway } from "../frontdoor/gateway/handler.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import { SupabaseAccountStore } from "../frontdoor/tenants/supabase-accounts.ts";
import { sampleCourse, sampleCourseBytes } from "./helpers/frontdoor-course.ts";

const SECRET = new TextEncoder().encode("course-start-test-secret-0123456789abcdef");
const NOW = Date.parse("2026-11-11T18:00:00Z");
const clerk: ClerkGateway = { authenticate: async () => ({ status: "signed-out" }), isSessionActive: async () => true };

let t: TestDb;
let tenant: Server;
let gateway: Server;
let course: Course;
let base = "";
let tenantId = "";
let cookie = "";
const library = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-start-"));
const logs: string[] = [];
const tenantHits: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
const pageHits: string[] = [];
let tenantFails = false;
let chats = 0;
let clock = NOW;

before(async () => {
	t = await createTestDb();
	const accounts = new SupabaseAccountStore(t.db);
	await accounts.confirmAge("user_course", new Date(NOW - 86_400_000));
	tenantId = await accounts.assignTenant("user_course");
	cookie = `${SESSION_COOKIE}=${await signSession({ userId: "user_course", sessionId: "sess_c", tenantId, checkedAt: NOW }, SECRET, NOW)}`;

	tenant = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			tenantHits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
			if (req.method === "POST" && req.url === "/api/chats") {
				if (tenantFails) {
					res.writeHead(500).end("boom");
					return;
				}
				const { title } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { title: string };
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: `chat_${++chats}`, title }));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/plain" }).end("from tenant");
		});
	});
	await new Promise<void>((r) => tenant.listen(0, "127.0.0.1", r));
	const tenantPort = (tenant.address() as AddressInfo).port;

	const frontDoorApp = (req: IncomingMessage, res: ServerResponse) => {
		pageHits.push(req.url ?? "");
		res.setHeader("X-Front-Door-App", "1");
		res.end("course page");
	};
	course = createCourse({
		db: t.db,
		accounts,
		sessionSecret: SECRET,
		libraryDir: library,
		billing: false,
		tenantFetch: (_tenantId, p, init) => fetch(`http://127.0.0.1:${tenantPort}${p}`, init),
		frontDoorApp,
		trustForwardedHeaders: false,
		now: () => clock,
		log: (line) => logs.push(line),
	});
	gateway = createServer(
		createGateway({
			accounts,
			clerk,
			supervisor: { ensureRunning: async () => tenantPort },
			provision: async () => {},
			sessionSecret: SECRET,
			secureCookies: false,
			trustForwardedHeaders: false,
			frontDoorApp,
			course: course.endpoint,
			now: () => clock,
		}),
	);
	await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
	course.close();
	await new Promise((r) => gateway.close(r));
	await new Promise((r) => tenant.close(r));
	await t.close();
	fs.rmSync(library, { recursive: true, force: true });
});

beforeEach(() => {
	tenantHits.length = 0;
	pageHits.length = 0;
	tenantFails = false;
});

function putCourseFile(): void {
	fs.mkdirSync(path.join(library, "course"), { recursive: true });
	fs.writeFileSync(path.join(library, "course", COURSE_FILE_NAME), sampleCourseBytes());
}

const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });
const startLeg = (leg: string, headers: Record<string, string> = {}) =>
	send("/course/start", {
		method: "POST",
		headers: { Cookie: cookie, Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...headers },
		body: new URLSearchParams({ leg }).toString(),
	});
const chatCreates = () => tenantHits.filter((h) => h.method === "POST" && h.url === "/api/chats");

describe("/course behind the front door's login", () => {
	it("sends a visitor with no login to sign in, and back to /course after", async () => {
		const res = await send("/course");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/account/sign-in?next=%2Fcourse");
		const post = await send("/course/start", { method: "POST", body: "leg=folding-the-dart", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
		assert.equal(post.status, 401);
		assert.deepEqual(tenantHits, []);
		assert.deepEqual(pageHits, []);
	});

	it("serves the page from the front door's own app, never the tenant", async () => {
		const res = await send("/course?error=starting", { headers: { Cookie: cookie } });
		assert.equal(res.headers.get("x-front-door-app"), "1");
		assert.equal(res.headers.get("cache-control"), "no-store");
		assert.deepEqual(pageHits, ["/course?error=starting"]);
		assert.deepEqual(tenantHits, []);
		assert.equal((await send("/course/other", { headers: { Cookie: cookie } })).status, 404);
		assert.equal((await send("/course/start", { headers: { Cookie: cookie } })).status, 405);
	});

	it("with no course file, a start goes back to /course (which says coming soon)", async () => {
		const res = await startLeg("folding-the-dart");
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/course");
		assert.deepEqual(chatCreates(), []);
		assert.deepEqual(await course.runtime.page(cookie), { status: "coming-soon" });
	});
});

describe("starting a lesson", () => {
	it("opens a new chat titled with the Leg, records the start, and lands on the chat with the first message", async () => {
		putCourseFile();
		const res = await startLeg("folding-the-dart");
		assert.equal(res.status, 303);
		const location = new URL(res.headers.get("location") ?? "", "http://x");
		assert.equal(location.pathname, "/chat/chat_1");
		const leg = findLeg(sampleCourse(), "folding-the-dart")!.leg;
		assert.equal(location.searchParams.get("prompt"), firstMessage(leg));
		assert.ok(location.searchParams.get("prompt")!.startsWith("I am a student pilot working toward the private pilot certificate."));

		const creates = chatCreates();
		assert.equal(creates.length, 1);
		assert.deepEqual(JSON.parse(creates[0]!.body), { title: "Folding the dart" });
		assert.match(String(creates[0]!.headers["content-type"]), /application\/json/);

		const starts = await dbm.listLegStarts(t.db, tenantId);
		assert.deepEqual(
			starts.map((s) => [s.legId, s.chatId, s.startedAt.getTime()]),
			[["folding-the-dart", "chat_1", NOW]],
		);
		const page = await course.runtime.page(cookie);
		assert.equal(page.status, "ready");
		if (page.status !== "ready") return;
		const legs = page.course.stages.flatMap((s) => s.subjects.flatMap((sub) => sub.legs));
		assert.deepEqual(legs.find((l) => l.id === "folding-the-dart")?.started?.chatId, "chat_1");
		assert.equal(legs.find((l) => l.id === "line-tension")?.started, null);
	});

	it("a second start of the same Leg opens a new chat, and Continue points at the newest", async () => {
		clock = NOW + 60_000;
		const res = await startLeg("folding-the-dart");
		assert.equal(new URL(res.headers.get("location") ?? "", "http://x").pathname, "/chat/chat_2");
		assert.deepEqual(
			(await dbm.listLegStarts(t.db, tenantId)).map((s) => s.chatId),
			["chat_2", "chat_1"],
		);
		const page = await course.runtime.page(cookie);
		if (page.status !== "ready") throw new Error(page.status);
		const leg = page.course.stages[0]!.subjects[0]!.legs[0]!;
		assert.equal(leg.started?.chatId, "chat_2");
		assert.equal(page.course.stages[0]!.subjects[0]!.startedCount, 1);
	});

	it("refuses a post from another site", async () => {
		const res = await startLeg("folding-the-dart", { Origin: "https://elsewhere.example" });
		assert.equal(res.status, 403);
		assert.deepEqual(chatCreates(), []);
	});

	it("goes back to /course for a Leg the course does not have, or when the tutor cannot open a chat", async () => {
		const missing = await startLeg("not-a-leg");
		assert.equal(missing.headers.get("location"), "/course?error=no-leg");
		assert.deepEqual(chatCreates(), []);

		tenantFails = true;
		const before = (await dbm.listLegStarts(t.db, tenantId)).length;
		const failed = await startLeg("line-tension");
		assert.equal(failed.status, 303);
		assert.equal(failed.headers.get("location"), "/course?error=starting");
		assert.equal((await dbm.listLegStarts(t.db, tenantId)).length, before, "no mark without a chat");
		assert.ok(logs.some((l) => /could not open a chat \(status 500\)/.test(l)));
	});

	it("opens no chat while the student is paused; /course shows why instead of Start", async () => {
		await dbm.pauseTenant(t.db, { tenantId, reason: "owner" });
		const res = await startLeg("line-tension");
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/course");
		assert.deepEqual(chatCreates(), []);
		const page = await course.runtime.page(cookie);
		assert.equal(page.status === "ready" && page.course.block, "paused");
		await dbm.unpauseTenant(t.db, { tenantId });
		const page2 = await course.runtime.page(cookie);
		assert.equal(page2.status === "ready" && page2.course.block, null);
	});

	it("with billing on, no plan, a used-up trial or an ended plan blocks new lessons", async () => {
		const { tenant: other } = await dbm.createStudentAccount(t.db, { clerkUserId: "user_course_billing", age18ConfirmedAt: new Date(NOW) });
		const on = databaseStartBlock(t.db, { billing: true });
		assert.equal(await databaseStartBlock(t.db, { billing: false })(other.id), null, "billing off: only a pause blocks");
		assert.equal(await on(other.id), "no-plan");
		const sub = { stripeSubscriptionId: "sub_course", tenantId: other.id, plan: "monthly" as const, trialStart: new Date(Date.now() - 86_400_000), eventCreatedAt: new Date(Date.now() - 60_000) };
		await dbm.upsertSubscription(t.db, { ...sub, status: "trialing" });
		assert.equal(await on(other.id), null, "a trial with time and cost left");
		await dbm.recordModelUsage(t.db, { tenantId: other.id, model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 50, requestId: "msg_course_cap" });
		assert.equal(await on(other.id), "trial-used");
		await dbm.upsertSubscription(t.db, { ...sub, status: "unpaid", eventCreatedAt: new Date(Date.now()) });
		assert.equal(await on(other.id), "plan-ended");
		await dbm.upsertSubscription(t.db, { ...sub, status: "active", eventCreatedAt: new Date(Date.now() + 1000) });
		assert.equal(await on(other.id), null);
	});
});

describe("Started marks without the course_leg_starts table (migration not applied)", () => {
	it("still starts the lesson, shows no marks, and logs one line", async () => {
		await t.db.query("drop table public.course_leg_starts");
		logs.length = 0;
		const res = await startLeg("line-tension");
		assert.equal(res.status, 303);
		assert.match(res.headers.get("location") ?? "", /^\/chat\/chat_\d+\?prompt=/);
		const page = await course.runtime.page(cookie);
		if (page.status !== "ready") throw new Error(page.status);
		assert.ok(page.course.stages.every((s) => s.subjects.every((sub) => sub.legs.every((l) => l.started === null))));
		await startLeg("folding-the-dart");
		await course.runtime.page(cookie);
		assert.deepEqual(logs, [MISSING_TABLE_LINE]);
	});

	it("with no database at all, marks are off and nothing is logged", async () => {
		const lines: string[] = [];
		const marks = legStartMarks(null, (l) => lines.push(l));
		await marks.record({ tenantId, legId: "x", chatId: "chat_x" });
		assert.equal((await marks.latestByLeg(tenantId)).size, 0);
		assert.deepEqual(lines, []);
	});

	it("logs only the error code for other database trouble", async () => {
		const lines: string[] = [];
		const broken = { query: async () => Promise.reject(Object.assign(new Error("value 'secret' is bad"), { code: "22001" })), transaction: async () => undefined } as unknown as dbm.Db;
		const marks = legStartMarks(broken, (l) => lines.push(l));
		await marks.record({ tenantId, legId: "x", chatId: "chat_x" });
		assert.equal((await marks.latestByLeg(tenantId)).size, 0);
		assert.deepEqual(lines, ["course: could not record a Leg start (error code 22001)", "course: could not read Leg starts (error code 22001)"]);
	});
});
