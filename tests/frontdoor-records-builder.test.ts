/**
 * North Aero study record (P6-01, C6 req 1): the pure builder in
 * frontdoor/records/. It turns upstream's read-only API payloads
 * (GET /api/chats, GET /api/chats/:id, GET /api/graph) plus the front
 * door's per-session active time into one record:
 *   - each session's date, active time (PD1), title and plan topics
 *   - plan progress, by upstream's own position rule
 *   - what the student learned: graph facts grouped by birth session,
 *     with imported-notes facts in their own section
 *
 * Owner rulings (2026-11-08): length = front door active time, a dash
 * until it exists; topics = plan topic titles; learned = plain list with
 * name and statement, no AI; header = name, print date, range, totals;
 * imported-notes facts get their own labeled section.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { derivePlanStatusesLh, type PlanTree } from "../src/core/contracts/plan.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	RECORD_LABEL,
	buildStudyRecord,
	formatDuration,
	planProgress,
	type RecordSource,
	type UpstreamChatRecord,
	type UpstreamChatSummary,
	type UpstreamGraph,
	type UpstreamMessage,
} from "../frontdoor/records/index.ts";

const TZ = "America/Los_Angeles";
const PRINTED = new Date("2026-11-08T18:00:00Z");

const METAR_TREE: PlanTree = {
	nodes: [
		{ id: "station", title: "Station identifier" },
		{ id: "wind", title: "Wind group" },
		{ id: "vis", title: "Visibility" },
		{ id: "sky", title: "Sky condition" },
	],
	edges: [
		{ from: "station", to: "wind" },
		{ from: "wind", to: "vis" },
		{ from: "vis", to: "sky" },
	],
	version: 1,
};

function quizCall(nodeId: string, name: "quiz" | "explain" = "quiz"): UpstreamMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "Check:" },
			{ type: "toolCall", id: `call_${nodeId}_${Math.random()}`, name, arguments: { nodeId, question: "?" } },
		],
		timestamp: 1,
	};
}

function summary(over: Partial<UpstreamChatSummary> & { id: string }): UpstreamChatSummary {
	return {
		title: over.id,
		createdAt: "2026-11-01T16:00:00.000Z",
		updatedAt: "2026-11-01T17:00:00.000Z",
		kind: "teach",
		messageCount: 2,
		phase: "teach",
		...over,
	};
}

function record(s: UpstreamChatSummary, over: Partial<UpstreamChatRecord> = {}): UpstreamChatRecord {
	return {
		id: s.id,
		title: s.title,
		createdAt: s.createdAt,
		updatedAt: s.updatedAt,
		kind: s.kind,
		messages: [{ role: "user", content: "hi", timestamp: 1 }],
		...over,
	};
}

const EMPTY_GRAPH: UpstreamGraph = { propositions: [], sessions: {}, fileSources: {} };

function source(chats: UpstreamChatSummary[], records: UpstreamChatRecord[], graph: UpstreamGraph = EMPTY_GRAPH): RecordSource {
	return { chats, records: Object.fromEntries(records.map((r) => [r.id, r])), graph };
}

const OPTS = { studentName: "Pat Lee", printedAt: PRINTED, timeZone: TZ };

describe("buildStudyRecord: sessions", () => {
	it("lists sessions oldest first, with dates in the caller's time zone", () => {
		const late = summary({ id: "c2", title: "Sky condition", createdAt: "2026-11-05T20:00:00.000Z" });
		// 03:30 UTC on Nov 3 is still Nov 2 in Los Angeles.
		const early = summary({ id: "c1", title: "Decode a METAR", createdAt: "2026-11-03T03:30:00.000Z" });
		const rec = buildStudyRecord(source([late, early], [record(late), record(early)]), OPTS);
		assert.deepEqual(rec.sessions.map((s) => s.id), ["c1", "c2"]);
		assert.equal(rec.sessions[0]!.date, "Nov 2, 2026");
		assert.equal(rec.sessions[1]!.date, "Nov 5, 2026");
		assert.equal(rec.firstDate, "Nov 2, 2026");
		assert.equal(rec.lastDate, "Nov 5, 2026");
		assert.equal(rec.sessionCount, 2);
	});

	it("leaves out sessions with no messages, and marks practice sessions", () => {
		const empty = summary({ id: "c0", title: "Untitled session", messageCount: 0 });
		const practice = summary({ id: "p1", title: "METAR drill", kind: "practice" });
		const rec = buildStudyRecord(source([empty, practice], [record(practice)]), OPTS);
		assert.deepEqual(rec.sessions.map((s) => [s.id, s.kind]), [["p1", "practice"]]);
	});

	it("skips a listed session whose record is missing (deleted between the two reads)", () => {
		const gone = summary({ id: "gone" });
		const kept = summary({ id: "kept" });
		const rec = buildStudyRecord(source([gone, kept], [record(kept)]), OPTS);
		assert.deepEqual(rec.sessions.map((s) => s.id), ["kept"]);
	});

	it("an empty record still builds, with no dates and zero totals", () => {
		const rec = buildStudyRecord(source([], []), OPTS);
		assert.equal(rec.sessionCount, 0);
		assert.equal(rec.firstDate, null);
		assert.equal(rec.lastDate, null);
		assert.equal(rec.studyTime.totalSeconds, null);
		assert.equal(rec.learned.totalFacts, 0);
	});
});

describe("buildStudyRecord: header", () => {
	it("carries the name, the print date in the time zone, the label, and the time zone", () => {
		const rec = buildStudyRecord(source([], []), { ...OPTS, printedAt: new Date("2026-11-09T05:00:00Z") });
		assert.equal(rec.studentName, "Pat Lee");
		assert.equal(rec.printedOn, "Nov 8, 2026");
		assert.equal(rec.timeZone, TZ);
		assert.equal(rec.label, RECORD_LABEL);
		assert.equal(RECORD_LABEL, "Self-study record. Not a logbook entry or instructor endorsement.");
	});

	it("rejects an unknown time zone instead of guessing one", () => {
		assert.throws(() => buildStudyRecord(source([], []), { ...OPTS, timeZone: "Mars/Olympus_Mons" }), RangeError);
	});
});

describe("buildStudyRecord: active time (PD1, from the front door)", () => {
	const a = summary({ id: "a", createdAt: "2026-11-01T16:00:00.000Z" });
	const b = summary({ id: "b", createdAt: "2026-11-02T16:00:00.000Z" });
	const c = summary({ id: "c", createdAt: "2026-11-03T16:00:00.000Z" });
	const src = source([a, b, c], [record(a), record(b), record(c)]);

	it("shows null (a dash) for every session when the front door has no records yet", () => {
		const rec = buildStudyRecord(src, OPTS);
		assert.deepEqual(rec.sessions.map((s) => s.activeSeconds), [null, null, null]);
		assert.deepEqual(rec.studyTime, { totalSeconds: null, recordedSessions: 0 });
	});

	it("uses the front door's seconds per session, and totals only what was recorded", () => {
		const rec = buildStudyRecord(src, { ...OPTS, activeSecondsBySession: { a: 2700, c: 1500 } });
		assert.deepEqual(rec.sessions.map((s) => s.activeSeconds), [2700, null, 1500]);
		assert.deepEqual(rec.studyTime, { totalSeconds: 4200, recordedSessions: 2 });
	});

	it("ignores front door time for sessions not in the record", () => {
		const rec = buildStudyRecord(src, { ...OPTS, activeSecondsBySession: { a: 60, other: 9999 } });
		assert.deepEqual(rec.studyTime, { totalSeconds: 60, recordedSessions: 1 });
	});

	it("refuses negative or non-finite seconds", () => {
		assert.throws(() => buildStudyRecord(src, { ...OPTS, activeSecondsBySession: { a: -1 } }), TypeError);
		assert.throws(() => buildStudyRecord(src, { ...OPTS, activeSecondsBySession: { a: Number.NaN } }), TypeError);
	});

	it("formats durations as minutes, then hours and minutes", () => {
		assert.equal(formatDuration(null), "–");
		assert.equal(formatDuration(0), "0 min");
		assert.equal(formatDuration(29), "0 min");
		assert.equal(formatDuration(2700), "45 min");
		assert.equal(formatDuration(3600), "1 h 0 min");
		assert.equal(formatDuration(3929), "1 h 5 min");
		assert.equal(formatDuration(36_000), "10 h 0 min");
	});
});

describe("buildStudyRecord: topics and plan progress", () => {
	it("topics are the plan's topic titles in plan order, each with its status", () => {
		const s = summary({ id: "m1", title: "Teach me to decode a METAR" });
		const r = record(s, {
			tree: METAR_TREE,
			messages: [{ role: "user", content: "go", timestamp: 1 }, quizCall("station"), quizCall("station"), quizCall("wind"), quizCall("vis")],
		});
		const rec = buildStudyRecord(source([s], [r]), OPTS);
		const plan = rec.sessions[0]!.plan;
		assert.ok(plan);
		assert.deepEqual(plan.topics, [
			{ title: "Station identifier", status: "covered" },
			{ title: "Wind group", status: "covered" },
			{ title: "Visibility", status: "in-progress" },
			{ title: "Sky condition", status: "not-yet" },
		]);
		assert.equal(plan.total, 4);
		assert.equal(plan.covered, 2);
		assert.equal(plan.current, "Visibility");
	});

	it("a session with no plan yet has plan null (title only)", () => {
		const s = summary({ id: "probe", phase: "probe" });
		const rec = buildStudyRecord(source([s], [record(s)]), OPTS);
		assert.equal(rec.sessions[0]!.plan, null);
	});

	it("a plan before the first check has nothing covered and no current topic", () => {
		const s = summary({ id: "fresh" });
		const rec = buildStudyRecord(source([s], [record(s, { tree: METAR_TREE })]), OPTS);
		assert.deepEqual(rec.sessions[0]!.plan, {
			topics: METAR_TREE.nodes.map((n) => ({ title: n.title, status: "not-yet" })),
			total: 4,
			covered: 0,
			current: null,
		});
	});
});

describe("planProgress follows upstream's derivePlanStatusesLh exactly (drift guard)", () => {
	const cases: Array<[string, UpstreamMessage[]]> = [
		["no messages", []],
		["linear walk", [quizCall("station"), quizCall("wind"), quizCall("vis")]],
		["repeat checks on one node collapse", [quizCall("station"), quizCall("station"), quizCall("wind"), quizCall("wind")]],
		["revisit a→b→a: a is current and visited", [quizCall("station"), quizCall("wind"), quizCall("station")]],
		["explain tags position too", [quizCall("station", "explain"), quizCall("sky")]],
		["unknown and untagged nodes move nothing", [quizCall("station"), quizCall("dropped-node"), { role: "assistant", content: [{ type: "toolCall", name: "quiz", arguments: {} }] }]],
		["user and tool messages are ignored", [{ role: "user", content: [{ type: "toolCall", name: "quiz", arguments: { nodeId: "sky" } }] }, quizCall("wind")]],
		["non-quiz tool calls are ignored", [{ role: "assistant", content: [{ type: "toolCall", name: "research", arguments: { nodeId: "sky" } }] }, quizCall("vis")]],
	];
	for (const [name, messages] of cases) {
		it(name, () => {
			const upstream = derivePlanStatusesLh(METAR_TREE, messages as unknown as LhMessage[]);
			const ours = planProgress(METAR_TREE, messages);
			const expected = METAR_TREE.nodes.map((n) => ({
				title: n.title,
				status: upstream.current === n.id ? "in-progress" : upstream.visited.has(n.id) ? "covered" : "not-yet",
			}));
			assert.deepEqual(ours.topics, expected);
			assert.equal(ours.current, upstream.current === null ? null : METAR_TREE.nodes.find((n) => n.id === upstream.current)!.title);
		});
	}
});

describe("buildStudyRecord: what the student learned (from the graph)", () => {
	const s1 = summary({ id: "chat_a", title: "Decode a METAR", createdAt: "2026-11-01T16:00:00.000Z" });
	const s2 = summary({ id: "chat_b", title: "Class B airspace", createdAt: "2026-11-02T16:00:00.000Z" });
	const graph: UpstreamGraph = {
		propositions: [
			{ id: "n3", name: "Mode C veil", statement: "A Mode C transponder is required within 30 NM of the Class B primary airport.", createdAt: "2026-11-02T17:00:00.000Z", provenance: [{ chatId: "chat_b" }] },
			{ id: "n2", name: "Visibility in SM", statement: "US METARs report visibility in statute miles.", createdAt: "2026-11-01T17:05:00.000Z", provenance: [{ chatId: "chat_a" }] },
			{ id: "n1", name: "Wind direction is true", statement: "METAR wind direction is referenced to true north.", createdAt: "2026-11-01T17:00:00.000Z", provenance: [{ chatId: "chat_a" }, { chatId: "chat_b" }] },
			{ id: "n4", name: "Vref", statement: "Vref is 1.3 times Vso.", createdAt: "2026-10-01T10:00:00.000Z", provenance: [{ chatId: "src_abc" }] },
			{ id: "n5", name: "Old fact", statement: "A fact whose session was deleted.", createdAt: "2026-09-01T10:00:00.000Z", provenance: [{ chatId: "chat_deleted" }] },
			{ id: "n6", name: "Legacy fact", statement: "A fact with no provenance.", createdAt: "2026-08-01T10:00:00.000Z", provenance: [] },
		],
		sessions: { chat_a: "Decode a METAR", chat_b: "Class B airspace" },
		fileSources: { src_abc: "/data/tenants/t1/uploads/pa28-notes.pdf" },
	};
	const rec = buildStudyRecord(source([s2, s1], [record(s1), record(s2)], graph), OPTS);

	it("groups facts by the session that first taught them, in session order, oldest fact first", () => {
		assert.deepEqual(
			rec.learned.sessionGroups.map((g) => [g.heading, g.date, g.facts.map((f) => f.name)]),
			[
				["Decode a METAR", "Nov 1, 2026", ["Wind direction is true", "Visibility in SM"]],
				["Class B airspace", "Nov 2, 2026", ["Mode C veil"]],
				["Session no longer listed", null, ["Old fact"]],
			],
		);
		assert.equal(rec.learned.sessionGroups[0]!.facts[0]!.statement, "METAR wind direction is referenced to true north.");
	});

	it("puts imported-notes facts in their own section, headed by the file name", () => {
		assert.deepEqual(
			rec.learned.notesGroups.map((g) => [g.heading, g.facts.map((f) => f.name)]),
			[["pa28-notes.pdf", ["Vref"]]],
		);
	});

	it("keeps facts with no recorded source, apart from the others", () => {
		assert.deepEqual(rec.learned.otherFacts.map((f) => f.name), ["Legacy fact"]);
	});

	it("counts every fact once", () => {
		assert.equal(rec.learned.totalFacts, 6);
	});
});
