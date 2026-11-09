/**
 * The report loop (W2-10; C6 req 3 acceptance tests, P6-03, P6-04, D26),
 * on a fresh in-process Postgres with every migration, and the in-memory
 * fake sender (nothing is sent).
 *
 *  - A session-end report goes out once after a session ends, only when
 *    the student turned it on.
 *  - The weekly report goes out once a week.
 *  - Turning a report off stops it.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import * as dbm from "../frontdoor/db/index.ts";
import { createTestDb, type TestDb } from "../frontdoor/db/testing.ts";
import { REPORT_LABEL } from "../frontdoor/email/copy.ts";
import { MemoryEmailSender } from "../frontdoor/email/sender.ts";
import type { RecordSource } from "../frontdoor/records/upstream.ts";
import { createReportRunner, MAX_ATTEMPTS, type ReportRunnerDeps } from "../frontdoor/reports/runner.ts";
import { MemoryStudentDirectory } from "../frontdoor/reports/students.ts";

const AGE = new Date("2026-10-01T12:00:00Z");
/** Sunday Nov 8, 2026, 9:00 am in Salinas. */
const T0 = Date.parse("2026-11-08T17:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);
const PUBLIC_URL = "https://ground.flynorthaero.com";

let t: TestDb;
let n = 0;

async function readyTenant(): Promise<string> {
	const { tenant } = await dbm.createStudentAccount(t.db, { clerkUserId: `user_rr_${++n}`, age18ConfirmedAt: AGE });
	await dbm.markTenantReady(t.db, tenant.id);
	return tenant.id;
}

/** One stretch of active study ending at `endMin`. */
async function study(tenantId: string, chatId: string | null, startMin: number, endMin: number): Promise<void> {
	await dbm.addActiveStudyTime(t.db, { tenantId, chatId, at: at(endMin), seconds: (endMin - startMin) * 60, maxGapSeconds: 300 });
}

function toolCall(nodeId: string, name = "quiz") {
	return { role: "assistant", content: [{ type: "toolCall", name, arguments: { nodeId } }] };
}

function source(): RecordSource {
	const iso = (d: Date) => d.toISOString();
	const summary = (id: string, title: string, created: Date) => ({ id, title, createdAt: iso(created), updatedAt: iso(created), kind: "teach" as const, messageCount: 6, phase: "teach" as const });
	return {
		chats: [summary("chat-a", "Weather basics", new Date("2026-11-01T17:00:00Z")), summary("chat-b", "Airspace", new Date("2026-11-03T17:00:00Z")), summary("chat-old", "Old session", new Date("2026-10-01T17:00:00Z"))],
		records: {
			"chat-a": {
				id: "chat-a",
				title: "Weather basics",
				createdAt: "2026-11-01T17:00:00Z",
				updatedAt: iso(at(40)),
				kind: "teach",
				tree: {
					nodes: [
						{ id: "n1", title: "METARs" },
						{ id: "n2", title: "TAFs" },
						{ id: "n3", title: "Fronts" },
					],
					edges: [],
					version: 1,
				},
				messages: [toolCall("n1"), toolCall("n2", "explain")],
			},
			"chat-b": { id: "chat-b", title: "Airspace", createdAt: "2026-11-03T17:00:00Z", updatedAt: "2026-11-05T17:00:00Z", kind: "teach", messages: [] },
			"chat-old": { id: "chat-old", title: "Old session", createdAt: "2026-10-01T17:00:00Z", updatedAt: "2026-10-01T17:00:00Z", kind: "practice", messages: [] },
		},
		graph: {
			propositions: [
				{ id: "p1", name: "METAR", statement: "A routine hourly weather report.", createdAt: iso(at(10)), provenance: [{ chatId: "chat-a" }] },
				{ id: "p0", name: "Older fact", statement: "Learned the day before.", createdAt: iso(at(-24 * 60)), provenance: [{ chatId: "chat-a" }] },
				{ id: "p2", name: "Class B", statement: "Busy airport airspace.", createdAt: "2026-11-05T18:00:00Z", provenance: [{ chatId: "chat-b" }] },
				{ id: "p3", name: "Notes fact", statement: "From imported notes.", createdAt: iso(at(12)), provenance: [{ chatId: "src_notes" }] },
			],
			sessions: {},
			fileSources: { src_notes: "/data/notes.pdf" },
		},
	};
}

function harness(over: Partial<ReportRunnerDeps> = {}) {
	const sender = new MemoryEmailSender();
	const students = new MemoryStudentDirectory();
	const lines: string[] = [];
	let clock = at(0);
	let reads = 0;
	const runner = createReportRunner({
		db: t.db,
		sender,
		students,
		readRecord: async () => {
			reads++;
			return source();
		},
		publicUrl: PUBLIC_URL,
		now: () => clock,
		log: (l) => lines.push(l),
		...over,
	});
	return {
		runner,
		sender,
		students,
		lines,
		reads: () => reads,
		setClock(d: Date) {
			clock = d;
		},
		sentTo: (tenantId: string) => sender.sent.filter((m) => m.tenantId === tenantId),
	};
}

async function sends(tenantId: string) {
	return t.db.query("select kind, chat_id, sitting_started_at, week_start::text as week_start, sent_at, provider_message_id from report_sends where tenant_id = $1 order by id", [tenantId]);
}

before(async () => {
	t = await createTestDb();
});
after(async () => {
	await t.close();
});

describe("session-end report (P6-03)", () => {
	it("sends nothing while session reports are off, which is the default", async () => {
		const tenant = await readyTenant();
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.setClock(at(80));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
		assert.equal(h.reads(), 0, "no record is read for a student with reports off");
		assert.equal((await dbm.getReportSettings(t.db, tenant)).sessionReportEnabled, false);
	});

	it("sends once, 30 minutes after the session ends, when turned on", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "cfi@example.com" });
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.students.set(tenant, { name: "Jane Doe", email: "jane@example.com" });

		h.setClock(at(55));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0, "15 idle minutes: the session may still go on");

		h.setClock(at(71));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 1);

		h.setClock(at(90));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 1, "never twice");

		const rows = await sends(tenant);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.kind, "session");
		assert.equal(rows[0]!.chat_id, "chat-a");
		assert.equal(new Date(rows[0]!.sitting_started_at as string).toISOString(), at(0).toISOString());
		assert.equal(rows[0]!.provider_message_id, "memory-1");
		assert.ok(rows[0]!.sent_at);
	});

	it("carries the session's record: date, study time, topics, the facts learned in it, the label, and unsubscribe", async () => {
		const tenant = await readyTenant();
		const { unsubscribeToken } = await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.students.set(tenant, { name: "Jane Doe", email: "jane@example.com" });
		h.setClock(at(75));
		await h.runner.runOnce();
		const [m] = h.sentTo(tenant);
		assert.ok(m);
		assert.equal(m.kind, "session-report");
		assert.equal(m.to, "jane@example.com");
		assert.equal(m.subject, "Study report: Jane Doe, Nov 8");
		for (const part of [m.text, m.html]) assert.equal(part.split(REPORT_LABEL).length - 1, 2, "N8 label at the top and the bottom");
		assert.match(m.text, /Student: Jane Doe\nDate: Nov 8, 2026\nStudy time: 40 min/);
		assert.match(m.text, /\* Weather basics\n {2}Study session\. Study time: 40 min\n {2}Plan: 1 of 3 topics covered\.\n {2}Covered: METARs\.\n {2}In progress: TAFs\.\n {2}Not yet: 1 topic\./);
		assert.match(m.text, /- METAR: A routine hourly weather report\./);
		assert.ok(!m.text.includes("Older fact"), "facts from an earlier sitting are left out");
		assert.ok(!m.text.includes("Notes fact"), "facts from imported notes are left out");
		assert.ok(!m.text.includes("Old session"));
		const link = `${PUBLIC_URL}/account/unsubscribe?t=${unsubscribeToken}&k=session`;
		assert.equal(m.headers?.["List-Unsubscribe"], `<${link}>`);
		assert.equal(m.headers?.["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
		assert.ok(m.text.includes(`Turn off session reports: ${link}`));
		assert.ok(m.text.includes(`Report settings: ${PUBLIC_URL}/account/reports`));
		assert.ok(m.html.includes(link.replace("&", "&amp;")));
	});

	it("leaves the name out when the account has none", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.setClock(at(75));
		await h.runner.runOnce();
		const [m] = h.sentTo(tenant);
		assert.equal(m?.subject, "Study report, Nov 8");
		assert.ok(!m?.text.includes("Student:"));
	});

	it("sends a new report when the student comes back to the same tutor session another day", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.setClock(at(75));
		await h.runner.runOnce();
		await study(tenant, "chat-a", 24 * 60, 24 * 60 + 25);
		h.setClock(at(24 * 60 + 60));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 2);
		assert.match(h.sentTo(tenant)[1]!.text, /Study time: 25 min/);
		assert.equal((await sends(tenant)).length, 2);
	});

	it("skips a quick look under 5 minutes, and time spent outside any tutor session", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 3);
		await study(tenant, null, 200, 240);
		const h = harness();
		h.setClock(at(300));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
		assert.equal((await sends(tenant)).length, 0);
	});

	it("stops when the student turns it off before the session ends", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: false });
		const h = harness();
		h.setClock(at(75));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
	});

	it("sends nothing to a student whose subscription ended (retention)", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		await dbm.startRetention(t.db, tenant, at(41));
		const h = harness();
		h.setClock(at(75));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
	});

	it("retries a failed send on the next run, gives up after the last try, and logs no address", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		const h = harness();
		h.setClock(at(75));
		const refusal = () => Object.assign(new Error("jane@example.com is not verified"), { name: "MessageRejected" });
		h.sender.failNext(refusal());
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
		assert.equal((await sends(tenant)).length, 0, "the claim is released");
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 1, "the next run sends it");

		const other = await readyTenant();
		await dbm.updateReportSettings(t.db, other, { sessionReportEnabled: true, reportEmail: "sam@example.com" });
		await study(other, "chat-a", 0, 40);
		for (let i = 0; i < MAX_ATTEMPTS; i++) {
			h.sender.failNext(refusal());
			await h.runner.runOnce();
		}
		await h.runner.runOnce();
		assert.equal(h.sentTo(other).length, 0, "given up after the last try");
		assert.equal((await sends(other)).length, 0);
		assert.ok(h.lines.some((l) => l.includes(`tenant ${other}`) && l.includes("MessageRejected")));
		assert.ok(h.lines.every((l) => !l.includes("@")), "no address in any log line");
	});

	it("releases the claim when the record cannot be read, so a later run tries again", async () => {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { sessionReportEnabled: true, reportEmail: "jane@example.com" });
		await study(tenant, "chat-a", 0, 40);
		let fail = true;
		const h = harness({
			readRecord: async () => {
				if (fail) throw new Error("tenant server not ready");
				return source();
			},
		});
		h.setClock(at(75));
		await h.runner.runOnce();
		assert.equal((await sends(tenant)).length, 0);
		fail = false;
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 1);
	});
});

describe("weekly report (P6-04)", () => {
	/** Monday Nov 9, 2026 at 8:05 am in Salinas. */
	const MONDAY = new Date("2026-11-09T16:05:00Z");

	async function weeklyTenant(): Promise<string> {
		const tenant = await readyTenant();
		await dbm.updateReportSettings(t.db, tenant, { weeklyReportEnabled: true, reportEmail: "cfi@example.com" });
		// Tuesday Nov 3 and Thursday Nov 5, school time.
		await dbm.addActiveStudyTime(t.db, { tenantId: tenant, chatId: "chat-a", at: new Date("2026-11-03T18:00:00Z"), seconds: 1800, maxGapSeconds: 300 });
		await dbm.addActiveStudyTime(t.db, { tenantId: tenant, chatId: "chat-b", at: new Date("2026-11-05T18:30:00Z"), seconds: 2700, maxGapSeconds: 300 });
		await dbm.addActiveStudyTime(t.db, { tenantId: tenant, chatId: "chat-a", at: new Date("2026-11-05T19:00:00Z"), seconds: 600, maxGapSeconds: 300 });
		return tenant;
	}

	it("sends last week's report once, from Monday 08:00 school time", async () => {
		const tenant = await weeklyTenant();
		const h = harness();
		h.students.set(tenant, { name: "Jane Doe", email: "jane@example.com" });
		h.setClock(new Date("2026-11-09T15:55:00Z"));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0, "7:55 am: not yet");
		h.setClock(MONDAY);
		await h.runner.runOnce();
		await h.runner.runOnce();
		h.setClock(new Date("2026-11-10T20:00:00Z"));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 1, "once a week");
		const rows = await sends(tenant);
		assert.equal(rows.length, 1);
		assert.equal(rows[0]!.kind, "weekly");
		assert.equal(rows[0]!.week_start, "2026-11-02");
		assert.ok(rows[0]!.sent_at);

		const m = h.sentTo(tenant)[0]!;
		assert.equal(m.kind, "weekly-report");
		assert.equal(m.to, "cfi@example.com");
		assert.equal(m.subject, "Weekly study report: Jane Doe, Nov 2 to Nov 8");
		assert.match(m.text, /Week: Nov 2 to Nov 8, 2026\nStudy time: 1 h 25 min\nSessions: 2\nNew facts: 3/);
		assert.match(m.text, /\* Weather basics\n {2}Study session\. Study time: 40 min/);
		assert.match(m.text, /\* Airspace\n {2}Study session\. Study time: 45 min\n {2}No plan yet\./);
		assert.match(m.text, /- METAR: /);
		assert.match(m.text, /- Class B: Busy airport airspace\./);
		assert.match(m.text, /- Older fact: Learned the day before\./);
		assert.ok(!m.text.includes("Notes fact"), "facts from imported notes are left out");
		assert.equal(m.text.split(REPORT_LABEL).length - 1, 2);
		assert.ok(m.headers?.["List-Unsubscribe"]?.includes("&k=weekly>"));
		assert.ok(m.text.includes("Turn off weekly reports: "));
	});

	it("skips a week with no study, and sends nothing outside the 48 hours after it is due", async () => {
		const tenant = await weeklyTenant();
		const h = harness();
		h.setClock(new Date("2026-11-11T16:05:00Z"));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0, "Wednesday: the window has closed");
		h.setClock(new Date("2026-11-16T16:05:00Z"));
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0, "no study in the week of Nov 9");
		assert.equal((await sends(tenant)).length, 0);
	});

	it("stops when the weekly report is turned off", async () => {
		const tenant = await weeklyTenant();
		await dbm.unsubscribeByToken(t.db, (await dbm.getReportSettings(t.db, tenant)).unsubscribeToken, "weekly");
		const h = harness();
		h.setClock(MONDAY);
		await h.runner.runOnce();
		assert.equal(h.sentTo(tenant).length, 0);
	});
});

describe("the loop", () => {
	it("joins a pass under way instead of starting a second one, and stops cleanly", async () => {
		const h = harness();
		h.setClock(at(0));
		const a = h.runner.runOnce();
		const b = h.runner.runOnce();
		assert.equal(a, b);
		await a;
		h.runner.start(60_000);
		await h.runner.stop();
	});
});
