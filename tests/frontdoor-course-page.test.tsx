/**
 * The /course page (master, 2026-11-11): the page's own login and 18+
 * check, "coming soon" with no course file, stages, subjects and Legs with
 * one, "Started" and "Continue" from the marks, and a plain sentence instead
 * of "Start lesson" while a lesson cannot start. Invented course data only.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { CourseScreen } from "../frontdoor/app/course/course-screen.tsx";
import type { StartBlock, StartBlockCheck } from "../frontdoor/course/blocks.ts";
import { BLOCK_COPY, COURSE_COPY } from "../frontdoor/course/copy.ts";
import { COURSE_FILE_NAME } from "../frontdoor/course/file.ts";
import { courseRuntime } from "../frontdoor/course/index.ts";
import type { LiveChats } from "../frontdoor/course/live-chats.ts";
import type { LegStartMarks, StartMark } from "../frontdoor/course/marks.ts";
import { getCourseRuntime } from "../frontdoor/course/registry.ts";
import { libraryCourseSource } from "../frontdoor/course/source.ts";
import { courseRedirect, courseView, type CoursePageState, type ShownCoursePage } from "../frontdoor/course/view.ts";
import { SESSION_COOKIE, signSession } from "../frontdoor/gateway/session.ts";
import { type Account, type AccountStore, InMemoryAccountStore } from "../frontdoor/tenants/accounts.ts";
import { sampleCourse, sampleCourseBytes } from "./helpers/frontdoor-course.ts";

const REPO = path.join(import.meta.dirname, "..");
const SECRET = new TextEncoder().encode("course-page-test-secret-0123456789abcdef");
const NOW = Date.parse("2026-11-11T18:00:00Z");
const library = fs.mkdtempSync(path.join(os.tmpdir(), "lh-course-page-"));
after(() => fs.rmSync(library, { recursive: true, force: true }));

const doc = (element: React.ReactElement) => parseHTML(`<html><body>${renderToStaticMarkup(element)}</body></html>`).document;
const text = (element: React.ReactElement) => (doc(element).body.textContent ?? "").replace(/\s+/g, " ");

const accounts = new InMemoryAccountStore();
await accounts.confirmAge("user_course", new Date(NOW - 86_400_000));
const tenantId = await accounts.assignTenant("user_course");

async function cookieFor(userId: string, tenant: string, secret = SECRET): Promise<string> {
	return `${SESSION_COOKIE}=${await signSession({ userId, sessionId: "sess_c", tenantId: tenant, checkedAt: NOW }, secret, NOW)}`;
}

/** Starts per Leg id, newest first (one start or a list). */
function marksOf(entries: Record<string, StartMark | StartMark[]>): LegStartMarks {
	return { record: async () => {}, startsByLeg: async () => new Map(Object.entries(entries).map(([legId, starts]) => [legId, Array.isArray(starts) ? starts : [starts]])) };
}

function runtimeWith(opts: { accounts?: AccountStore; marks?: LegStartMarks; block?: StartBlock | null; liveChats?: LiveChats } = {}) {
	const startBlock: StartBlockCheck = async () => opts.block ?? null;
	return courseRuntime({
		accounts: opts.accounts ?? accounts,
		sessionSecret: SECRET,
		now: () => NOW,
		source: libraryCourseSource(library),
		marks: opts.marks ?? marksOf({}),
		startBlock,
		...(opts.liveChats ? { liveChats: opts.liveChats } : {}),
	});
}

function putCourseFile(): void {
	fs.mkdirSync(path.join(library, "course"), { recursive: true });
	fs.writeFileSync(path.join(library, "course", COURSE_FILE_NAME), sampleCourseBytes());
}

describe("/course: login and 18+", () => {
	it("sends a visitor with no login, or a bad one, to sign in, then back to /course", async () => {
		const rt = runtimeWith();
		assert.deepEqual(await rt.page(undefined), { status: "sign-in" });
		assert.deepEqual(await rt.page(await cookieFor("user_course", tenantId, new TextEncoder().encode("another-secret-another-secret-0123456789"))), { status: "sign-in" });
		assert.deepEqual(await rt.page(await cookieFor("user_nobody", tenantId)), { status: "sign-in" }, "no account");
		assert.deepEqual(await rt.page(await cookieFor("user_course", "00000000-0000-5000-8000-000000000000")), { status: "sign-in" }, "another tenant");
		assert.equal(courseRedirect({ status: "sign-in" }), "/account/sign-in?next=%2Fcourse");
	});

	it("sends a login with no 18+ tick on file to the 18+ form, then back to /course", async () => {
		const noTick: AccountStore = {
			get: async (userId): Promise<Account> => ({ userId, tenantId, ageConfirmedAt: null, createdAt: new Date(NOW) }),
			confirmAge: async () => {
				throw new Error("not used");
			},
			assignTenant: async () => tenantId,
		};
		assert.deepEqual(await runtimeWith({ accounts: noTick }).page(await cookieFor("user_course", tenantId)), { status: "confirm-age" });
		assert.equal(courseRedirect({ status: "confirm-age" }), "/account/confirm-age?next=%2Fcourse");
		assert.equal(courseRedirect({ status: "coming-soon" }), null);
	});

	it("the page itself redirects on those two answers, and is not found without the front door", () => {
		const source = fs.readFileSync(path.join(REPO, "frontdoor", "app", "course", "page.tsx"), "utf8");
		assert.match(source, /courseRedirect\(state\)/);
		assert.match(source, /if \(!rt\) notFound\(\)/);
		assert.equal(getCourseRuntime(), null, "no runtime is registered by these tests");
	});
});

describe("/course without and with a course file", () => {
	it("says the course is coming soon when no file is on the volume", async () => {
		const state = await runtimeWith().page(await cookieFor("user_course", tenantId));
		assert.deepEqual(state, { status: "coming-soon" });
		const t = text(<CourseScreen state={state as ShownCoursePage} />);
		assert.match(t, /The course is coming soon/);
		assert.equal(doc(<CourseScreen state={state as ShownCoursePage} />).querySelectorAll("form").length, 0);
	});

	it("shows stages, then subjects, then Legs with title, outcome and key point count, and a Start button each", async () => {
		putCourseFile();
		const state = await runtimeWith().page(await cookieFor("user_course", tenantId));
		assert.equal(state.status, "ready");
		const page = doc(<CourseScreen state={state as ShownCoursePage} />);
		assert.deepEqual([...page.querySelectorAll("h2")].map((h) => h.textContent), ["Before you solo", "Checkride prep"]);
		assert.deepEqual(
			[...page.querySelectorAll("summary")].map((s) => (s.textContent ?? "").replace(/\s+/g, " ").trim()),
			["Paper planes 2 lessons", "Kite flying 1 lesson"],
		);
		const t = text(<CourseScreen state={state as ShownCoursePage} />);
		assert.match(t, /Sample ground school/);
		const legs = [...page.querySelectorAll("li")].map((li) => [...li.children].slice(0, 3).map((c) => c.textContent));
		assert.deepEqual(legs, [
			["Folding the dart", "Fold a dart that flies straight.", "2 key points"],
			["Throwing level", "Throw the dart level and let it glide.", "2 key points"],
			["Line tension", "Keep the line tight as the wind drops.", "1 key point"],
		]);
		const forms = [...page.querySelectorAll("form")];
		assert.equal(forms.length, 3);
		for (const form of forms) {
			assert.equal(form.getAttribute("action"), "/course/start");
			assert.equal(form.getAttribute("method"), "post");
		}
		assert.deepEqual(
			forms.map((form) => form.querySelector("input[name=leg]")?.getAttribute("value")),
			["folding-the-dart", "throwing-level", "line-tension"],
		);
		assert.deepEqual(
			forms.map((form) => form.querySelector("button")?.textContent),
			[COURSE_COPY.start, COURSE_COPY.start, COURSE_COPY.start],
		);
		for (const id of ["folding-the-dart", "throwing-level", "line-tension", "paper-planes", "kite-flying", "checkride", "sample-course"]) assert.equal(t.includes(id), false, `${id} is shown`);
		assert.equal(t.includes("ZZ."), false, "ACS codes are for the tutor's first message, not the page");
		assert.equal(t.includes("Which paper to use"), false, "labels are for the first message");
	});

	it("marks a started Leg, with Continue to its chat and Start again", async () => {
		const marks = marksOf({ "folding-the-dart": { chatId: "chat_abc-1", startedAt: new Date(NOW - 3600_000) } });
		const state = await runtimeWith({ marks }).page(await cookieFor("user_course", tenantId));
		const page = doc(<CourseScreen state={state as ShownCoursePage} />);
		const first = page.querySelector("li");
		assert.match(first?.textContent ?? "", /Folding the dart\s*Started/);
		assert.equal(first?.querySelector("a")?.getAttribute("href"), "/chat/chat_abc-1");
		assert.equal(first?.querySelector("a")?.textContent, COURSE_COPY.continue);
		assert.equal(first?.querySelector("button")?.textContent, COURSE_COPY.startAgain);
		assert.match(page.querySelector("summary")?.textContent ?? "", /1 of 2 started/);
		assert.equal([...page.querySelectorAll("li")][1]?.textContent?.includes("Started"), false);
	});

	it("Continue skips chats deleted in the tutor; with none left, Started stays and Start lesson is back", async () => {
		const marks = marksOf({
			"folding-the-dart": [
				{ chatId: "chat_new", startedAt: new Date(NOW) },
				{ chatId: "chat_old", startedAt: new Date(NOW - 3600_000) },
			],
			"throwing-level": { chatId: "chat_gone", startedAt: new Date(NOW) },
		});
		const asked: string[] = [];
		const liveChats: LiveChats = async (tenant) => {
			asked.push(tenant);
			return new Set(["chat_old"]);
		};
		const state = await runtimeWith({ marks, liveChats }).page(await cookieFor("user_course", tenantId));
		assert.deepEqual(asked, [tenantId], "one read of the chat list per page");
		const page = doc(<CourseScreen state={state as ShownCoursePage} />);
		const [first, second] = [...page.querySelectorAll("li")];
		assert.equal(first?.querySelector("a")?.getAttribute("href"), "/chat/chat_old");
		assert.equal(first?.querySelector("button")?.textContent, COURSE_COPY.startAgain);
		assert.match(second?.textContent ?? "", /Throwing level\s*Started/);
		assert.equal(second?.querySelector("a"), null, "no Continue to a deleted chat");
		assert.equal(second?.querySelector("button")?.textContent, COURSE_COPY.start);
		assert.match(page.querySelector("summary")?.textContent ?? "", /2 of 2 started/);

		const down = await runtimeWith({ marks, liveChats: async () => null }).page(await cookieFor("user_course", tenantId));
		const links = [...doc(<CourseScreen state={down as ShownCoursePage} />).querySelectorAll("li a")].map((a) => a.getAttribute("href"));
		assert.deepEqual(links, ["/chat/chat_new", "/chat/chat_gone"], "tenant server down: the newest start, as before");

		let calls = 0;
		const counted: LiveChats = async () => {
			calls++;
			return null;
		};
		await runtimeWith({ liveChats: counted }).page(await cookieFor("user_course", tenantId));
		assert.equal(calls, 0, "no starts: the tenant server is not asked");
	});

	it("shows a plain sentence instead of Start while paused or at a budget cap", async () => {
		for (const block of ["paused", "trial-used", "plan-ended", "no-plan"] as const) {
			const marks = marksOf({ "line-tension": { chatId: "chat_9", startedAt: new Date(NOW) } });
			const state = await runtimeWith({ block, marks }).page(await cookieFor("user_course", tenantId));
			const page = doc(<CourseScreen state={state as ShownCoursePage} />);
			assert.equal(page.querySelectorAll("form").length, 0, block);
			assert.ok((page.querySelector("[role=status]")?.textContent ?? "").includes(BLOCK_COPY[block].text), block);
			assert.equal(page.querySelector('a[href="/chat/chat_9"]')?.textContent, COURSE_COPY.continue, "Continue still works");
			if (block !== "paused") assert.ok(page.querySelector('a[href="/account/plans"]'), block);
		}
		assert.match(BLOCK_COPY.paused.text, /Your account is paused for a fair-use review\. Contact North Aero\./);
	});

	it("shows a start error from the query, and ignores unknown ones", () => {
		const state: CoursePageState = { status: "ready", course: courseView(sampleCourse(), new Map(), null) };
		assert.match(text(<CourseScreen state={state} error="starting" />), /Your tutor is starting\. Try again in a minute\./);
		assert.match(text(<CourseScreen state={state} error="no-leg" />), /not in the course any more/);
		for (const odd of ["constructor", "__proto__", "x"]) assert.equal(doc(<CourseScreen state={state} error={odd} />).querySelector("[role=alert]"), null, odd);
	});
});

describe("words and links", () => {
	it("keeps the page's words in one copy file with no em dash", () => {
		const copy = fs.readFileSync(path.join(REPO, "frontdoor", "course", "copy.ts"), "utf8");
		assert.equal(copy.includes("—"), false);
		for (const b of Object.values(BLOCK_COPY)) assert.equal(b.text.includes("—"), false);
	});

	it("the tutor's sidebar links to /course, recorded as an upstream change", () => {
		const sidebar = fs.readFileSync(path.join(REPO, "components", "sidebar.tsx"), "utf8");
		assert.match(sidebar, /<a href="\/course" data-testid="course-link"[^>]*>Course<\/a>/);
		const changes = fs.readFileSync(path.join(REPO, "docs", "upstream-changes.md"), "utf8");
		assert.match(changes, /\| `components\/sidebar\.tsx` \| Course \|/);
	});
});
