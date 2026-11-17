/**
 * Starting a course lesson through the gateway (master, 2026-11-11; lesson
 * outline 2026-11-17):
 * /course needs the front door's login like a tutor page; "Start lesson"
 * opens a new chat on the student's own tutor server with upstream's own
 * POST /api/chats, records a Started mark, and lands on /chat/<id>?prompt=
 * with the lesson's first message. The marks work with the table and
 * without it. "Continue" skips chats the student deleted in the tutor.
 * Invented course data only.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { databaseStartBlock } from "../frontdoor/course/blocks.ts";
import { chatStartPath, chatTitle, type Course, createCourse } from "../frontdoor/course/index.ts";
import { COURSE_FILE_NAME, findLesson } from "../frontdoor/course/file.ts";
import { firstMessage } from "../frontdoor/course/first-message.ts";
import { tenantLiveChats } from "../frontdoor/course/live-chats.ts";
import { lessonStartMarks, MISSING_TABLE_LINE } from "../frontdoor/course/marks.ts";
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
/** The tenant server drops the connection on GET /api/chats. */
let tenantDown = false;
let chats = 0;
/** The chats the tenant server still has (a student can delete one in the tutor). */
const liveChats = new Set<string>();
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
				const id = `chat_${++chats}`;
				liveChats.add(id);
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id, title }));
				return;
			}
			if (req.method === "GET" && req.url === "/api/chats") {
				if (tenantDown) {
					req.socket.destroy();
					return;
				}
				const at = new Date(NOW).toISOString();
				const list = [...liveChats].map((id) => ({ id, title: "Lesson", createdAt: at, updatedAt: at, kind: "teach", messageCount: 0, phase: "probe" }));
				res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ chats: list }));
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
	tenantDown = false;
});

function putCourseFile(): void {
	fs.mkdirSync(path.join(library, "course"), { recursive: true });
	fs.writeFileSync(path.join(library, "course", COURSE_FILE_NAME), sampleCourseBytes());
}

const send = (p: string, init: RequestInit = {}) => fetch(`${base}${p}`, { redirect: "manual", ...init });
const startLesson = (lesson: string, headers: Record<string, string> = {}) =>
	send("/course/start", {
		method: "POST",
		headers: { Cookie: cookie, Origin: base, "Content-Type": "application/x-www-form-urlencoded", ...headers },
		body: new URLSearchParams({ lesson }).toString(),
	});
const chatCreates = () => tenantHits.filter((h) => h.method === "POST" && h.url === "/api/chats");

describe("/course behind the front door's login", () => {
	it("sends a visitor with no login to sign in, and back to /course after", async () => {
		const res = await send("/course");
		assert.equal(res.status, 302);
		assert.equal(res.headers.get("location"), "/account/sign-in?next=%2Fcourse");
		const post = await send("/course/start", { method: "POST", body: "lesson=l01", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
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
		const res = await startLesson("l01");
		assert.equal(res.status, 303);
		assert.equal(res.headers.get("location"), "/course");
		assert.deepEqual(chatCreates(), []);
		assert.deepEqual(await course.runtime.page(cookie), { status: "coming-soon" });
	});
});

describe("starting a lesson", () => {
	it("opens a new chat titled with the lesson, records the start under the lesson id, and lands on the chat with the first message", async () => {
		putCourseFile();
		const res = await startLesson("l01");
		assert.equal(res.status, 303);
		const location = new URL(res.headers.get("location") ?? "", "http://x");
		assert.equal(location.pathname, "/chat/chat_1");
		const found = findLesson(sampleCourse(), "l01")!;
		assert.equal(location.searchParams.get("prompt"), firstMessage(found));
		assert.ok(location.searchParams.get("prompt")!.startsWith("I am a student pilot working toward the FAA private pilot certificate. I would like to work on this lesson.\n\nLesson 1: Kite shapes and line\nStage 1: Before the first flight\n\n"));
		assert.equal(res.headers.get("location"), chatStartPath("chat_1", firstMessage(found)));

		const creates = chatCreates();
		assert.equal(creates.length, 1);
		assert.deepEqual(JSON.parse(creates[0]!.body), { title: "Lesson 1: Kite shapes and line" });
		assert.equal(chatTitle(found.lesson), "Lesson 1: Kite shapes and line");
		assert.match(String(creates[0]!.headers["content-type"]), /application\/json/);

		const starts = await dbm.listLessonStarts(t.db, tenantId);
		assert.deepEqual(
			starts.map((s) => [s.lessonId, s.chatId, s.startedAt.getTime()]),
			[["l01", "chat_1", NOW]],
		);
		const [row] = await t.db.query("select leg_id from course_leg_starts where chat_id = 'chat_1'");
		assert.equal(row?.leg_id, "l01", "the table's leg_id column holds the lesson id");
		const page = await course.runtime.page(cookie);
		assert.equal(page.status, "ready");
		if (page.status !== "ready") return;
		const lessons = page.course.stages.flatMap((s) => s.groups.flatMap((g) => g.lessons));
		assert.deepEqual(lessons.find((l) => l.id === "l01")?.started?.chatId, "chat_1");
		assert.equal(lessons.find((l) => l.id === "l05")?.started, null);
	});

	it("a second start of the same lesson opens a new chat, and Continue points at the newest", async () => {
		clock = NOW + 60_000;
		const res = await startLesson("l01");
		assert.equal(new URL(res.headers.get("location") ?? "", "http://x").pathname, "/chat/chat_2");
		assert.deepEqual(
			(await dbm.listLessonStarts(t.db, tenantId)).map((s) => s.chatId),
			["chat_2", "chat_1"],
		);
		const page = await course.runtime.page(cookie);
		if (page.status !== "ready") throw new Error(page.status);
		const lesson = page.course.stages[0]!.groups[0]!.lessons[0]!;
		assert.equal(lesson.started?.chatId, "chat_2");
		assert.equal(lesson.continueChatId, "chat_2");
	});

	it("refuses a post from another site", async () => {
		const res = await startLesson("l01", { Origin: "https://elsewhere.example" });
		assert.equal(res.status, 403);
		assert.deepEqual(chatCreates(), []);
	});

	it("goes back to /course for a lesson the course does not have, or when the tutor cannot open a chat", async () => {
		const missing = await startLesson("l99");
		assert.equal(missing.headers.get("location"), "/course?error=no-lesson");
		assert.deepEqual(chatCreates(), []);

		tenantFails = true;
		const before = (await dbm.listLessonStarts(t.db, tenantId)).length;
		const failed = await startLesson("l05");
		assert.equal(failed.status, 303);
		assert.equal(failed.headers.get("location"), "/course?error=starting");
		assert.equal((await dbm.listLessonStarts(t.db, tenantId)).length, before, "no mark without a chat");
		assert.ok(logs.some((l) => /could not open a chat \(status 500\)/.test(l)));
	});

	it("opens no chat while the student is paused; /course shows why instead of Start", async () => {
		await dbm.pauseTenant(t.db, { tenantId, reason: "owner" });
		const res = await startLesson("l05");
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

describe("Continue after the student deletes a chat in the tutor", () => {
	// From the tests above: lesson l01 was started twice, chat_2 (newest) then chat_1.
	async function firstLesson() {
		const page = await course.runtime.page(cookie);
		if (page.status !== "ready") throw new Error(page.status);
		const lessons = page.course.stages.flatMap((s) => s.groups.flatMap((g) => g.lessons));
		return { lesson: lessons.find((l) => l.id === "l01")!, startedCount: lessons.filter((l) => l.started).length };
	}
	const chatListReads = () => tenantHits.filter((h) => h.method === "GET" && h.url === "/api/chats");

	it("links Continue to the newest chat while it still exists", async () => {
		const { lesson } = await firstLesson();
		assert.equal(lesson.started?.chatId, "chat_2");
		assert.equal(lesson.continueChatId, "chat_2");
		assert.equal(chatListReads().length, 1, "one read of the chat list per page");
		assert.match(String(chatListReads()[0]!.headers.accept), /application\/json/);
	});

	it("falls back to the newest earlier chat for the lesson when the newest was deleted", async () => {
		liveChats.delete("chat_2");
		const { lesson, startedCount } = await firstLesson();
		assert.equal(lesson.continueChatId, "chat_1");
		assert.equal(lesson.started?.chatId, "chat_2", "the Started mark stays");
		assert.equal(startedCount, 1);
	});

	it("shows Start lesson again, and keeps Started, when every chat for the lesson was deleted", async () => {
		liveChats.delete("chat_1");
		const { lesson, startedCount } = await firstLesson();
		assert.equal(lesson.continueChatId, null);
		assert.notEqual(lesson.started, null, "the Started mark stays");
		assert.equal(startedCount, 1);
	});

	it("keeps today's link to the newest chat when the tenant server does not answer", async () => {
		tenantDown = true;
		logs.length = 0;
		const { lesson } = await firstLesson();
		assert.equal(lesson.continueChatId, "chat_2");
		assert.equal(lesson.started?.chatId, "chat_2");
		assert.ok(logs.some((l) => /^course: could not list tenant .+'s chats \(TypeError\), so Continue links the newest start$/.test(l)), logs.join("\n"));

		const lines: string[] = [];
		const hung = tenantLiveChats(() => new Promise<Response>(() => {}), (l) => lines.push(l), 50);
		assert.equal(await hung(tenantId), null, "no answer in time");
		assert.match(lines[0] ?? "", /\(TimeoutError\b/);
	});
});

describe("a lesson on rules the ACS does not cover", () => {
	it("starts like any lesson, with the 14 CFR paragraphs in the first message", async () => {
		const res = await startLesson("l04");
		assert.equal(res.status, 303);
		const location = new URL(res.headers.get("location") ?? "", "http://x");
		const prompt = location.searchParams.get("prompt") ?? "";
		assert.equal(prompt, firstMessage(findLesson(sampleCourse(), "l04")!));
		assert.match(prompt, /\n\nFrom 14 CFR Part 199 \(the ACS does not cover these rules\):\n- 199\.5 Kites near airports:\n {2}- \(a\) Line length\n/);
		const chatId = location.pathname.slice("/chat/".length);
		assert.deepEqual(JSON.parse(chatCreates()[0]!.body), { title: "Lesson 4: Kite rules near airports" });
		assert.equal((await dbm.listLessonStarts(t.db, tenantId)).find((s) => s.chatId === chatId)?.lessonId, "l04");
	});
});

describe("Started marks without the course_leg_starts table (migration not applied)", () => {
	it("still starts the lesson, shows no marks, and logs one line", async () => {
		await t.db.query("drop table public.course_leg_starts");
		logs.length = 0;
		const res = await startLesson("l05");
		assert.equal(res.status, 303);
		assert.match(res.headers.get("location") ?? "", /^\/chat\/chat_\d+\?prompt=/);
		const page = await course.runtime.page(cookie);
		if (page.status !== "ready") throw new Error(page.status);
		assert.ok(page.course.stages.every((s) => s.groups.every((g) => g.lessons.every((l) => l.started === null))));
		await startLesson("l01");
		await course.runtime.page(cookie);
		assert.deepEqual(logs, [MISSING_TABLE_LINE]);
	});

	it("with no database at all, marks are off and nothing is logged", async () => {
		const lines: string[] = [];
		const marks = lessonStartMarks(null, (l) => lines.push(l));
		await marks.record({ tenantId, lessonId: "x", chatId: "chat_x" });
		assert.equal((await marks.startsByLesson(tenantId)).size, 0);
		assert.deepEqual(lines, []);
	});

	it("logs only the error code for other database trouble", async () => {
		const lines: string[] = [];
		const broken = { query: async () => Promise.reject(Object.assign(new Error("value 'secret' is bad"), { code: "22001" })), transaction: async () => undefined } as unknown as dbm.Db;
		const marks = lessonStartMarks(broken, (l) => lines.push(l));
		await marks.record({ tenantId, lessonId: "x", chatId: "chat_x" });
		assert.equal((await marks.startsByLesson(tenantId)).size, 0);
		assert.deepEqual(lines, ["course: could not record a lesson start (error code 22001)", "course: could not read lesson starts (error code 22001)"]);
	});
});
