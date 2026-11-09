/**
 * Reporting contract tests (C7 req 7, P3-06 first half; P6-01 data).
 *
 * The front door reads these upstream routes on each tenant's own server:
 *   GET /api/chats                topics for the dashboard (C7 req 6)
 *   GET /api/chats/:id/markdown   session text, consent only (C7 req 6)
 *   GET /api/chats/:id            plan tree + messages (study record)
 *   GET /api/graph                facts learned (study record)
 *
 * These tests start a REAL upstream server (`next dev`, see
 * tests/helpers/frontdoor-records-upstream.ts) on a throwaway data
 * folder seeded through upstream's own stores, with an empty key file,
 * so no model call can happen. They check each response's shape the way
 * the front door reads it, so an upstream change that would break
 * reporting turns `npm test` red. Run them again after every upstream
 * merge (docs/plan.md).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { ChatListItem, ChatRecord } from "../src/core/contracts/chat.ts";
import type { GraphSnapshot } from "../src/core/contracts/graph.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import {
	RECORD_LABEL,
	buildStudyRecord,
	fetchRecordSource,
	parseChatList,
	parseChatRecord,
	parseGraph,
	planProgress,
	renderStudyRecordHtml,
	type UpstreamChatRecord,
	type UpstreamChatSummary,
	type UpstreamGraph,
} from "../frontdoor/records/index.ts";
import { startUpstreamDevServer, type UpstreamServer } from "./helpers/frontdoor-records-upstream.ts";

// Compile-time half of the contract: upstream's own types must still fit
// what the front door reads. A rename or type change fails `npm run typecheck`.
type Fits<A, B> = A extends B ? true : false;
const typeContract: [Fits<ChatListItem, UpstreamChatSummary>, Fits<ChatRecord, UpstreamChatRecord>, Fits<GraphSnapshot, UpstreamGraph>] = [true, true, true];
void typeContract;

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-fd-contract-"));
const DATA = path.join(TMP, "data");
const AUTH = path.join(TMP, "auth.json");
fs.writeFileSync(AUTH, "{}\n", "utf-8");
process.env.LH_DATA_DIR = DATA;
process.env.LH_AUTH_FILE = AUTH;

const METAR_TREE: PlanTree = {
	nodes: [
		{ id: "station", title: "Station identifier" },
		{ id: "wind", title: "Wind group" },
		{ id: "vis", title: "Visibility" },
	],
	edges: [
		{ from: "station", to: "wind" },
		{ from: "wind", to: "vis" },
	],
	version: 1,
};

let n = 0;
const ts = () => Date.parse("2026-11-01T17:00:00Z") + n++ * 60_000;
const user = (text: string) => ({ id: `msg_u${n}`, role: "user", content: text, timestamp: ts() });
const assistant = (content: unknown[]) => ({
	id: `msg_a${n}`,
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop",
	timestamp: ts(),
});
const quiz = (nodeId: string) =>
	assistant([
		{ type: "text", text: `Let's check ${nodeId}.` },
		{
			type: "toolCall",
			id: `call_${nodeId}_${n}`,
			name: "quiz",
			arguments: { type: "check", nodeId, question: `Question about ${nodeId}?`, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
		},
	]);

let server: UpstreamServer;
let teachId: string;
let practiceId: string;
let emptyId: string;
const TEACH_TITLE = "Teach me to decode a METAR";
const SRC_ID = "src_contract01";

before(async () => {
	const { chatStore } = await import("../src/store/chats.ts");
	const { graphStore } = await import("../src/store/graph.ts");

	const teach = chatStore.createChat(TEACH_TITLE);
	teachId = teach.id;
	chatStore.saveTree(teachId, METAR_TREE);
	chatStore.saveMessages(teachId, [
		user("Teach me to decode a METAR"),
		assistant([{ type: "text", text: "A METAR is a routine surface observation." }]),
		quiz("station"),
		quiz("wind"),
	] as unknown as LhMessage[]);

	const practice = chatStore.createChat("METAR drill", "practice");
	practiceId = practice.id;
	chatStore.saveMessages(practiceId, [user("Drill me"), assistant([{ type: "text", text: "Decode KSFO 081756Z 28012KT 10SM FEW015." }])] as unknown as LhMessage[]);

	emptyId = chatStore.createChat("Untitled session").id;

	graphStore.appendNode({
		id: "n_wind_true",
		name: "Wind direction is true",
		statement: "METAR wind direction is referenced to true north.",
		aliases: [],
		createdAt: "2026-11-01T17:10:00.000Z",
		provenance: [{ chatId: teachId, messageId: "msg_a1" }],
	});
	graphStore.appendNode({
		id: "n_vis_sm",
		name: "Visibility in statute miles",
		statement: "US METARs report prevailing visibility in statute miles.",
		aliases: [],
		createdAt: "2026-11-01T17:12:00.000Z",
		provenance: [{ chatId: teachId, messageId: "msg_a2" }],
	});
	graphStore.upsertSource({ id: SRC_ID, filePath: "uploads/pa28-notes.md", importedAt: "2026-10-30T12:00:00.000Z" });
	graphStore.appendNode({
		id: "n_vref",
		name: "Vref",
		statement: "Vref is 1.3 times Vso.",
		aliases: [],
		createdAt: "2026-10-30T12:01:00.000Z",
		provenance: [{ chatId: SRC_ID, messageId: "" }],
	});

	server = await startUpstreamDevServer({ dataDir: DATA, authFile: AUTH });
}, { timeout: 180_000 });

after(async () => {
	await server?.stop();
	fs.rmSync(TMP, { recursive: true, force: true });
});

async function get(route: string): Promise<Response> {
	return fetch(server.url + route, { signal: AbortSignal.timeout(60_000) });
}

const ISO = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));

describe("GET /api/chats (dashboard topics, record session list)", { timeout: 120_000 }, () => {
	it("answers 200 JSON { chats: ChatListItem[] } with the fields the front door reads", async () => {
		const res = await get("/api/chats");
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
		const body = (await res.json()) as { chats: Array<Record<string, unknown>> };
		assert.ok(Array.isArray(body.chats));
		assert.equal(body.chats.length, 3);
		for (const c of body.chats) {
			assert.equal(typeof c.id, "string");
			assert.equal(typeof c.title, "string");
			assert.ok(ISO(c.createdAt) && ISO(c.updatedAt), "ISO timestamps");
			assert.ok(c.kind === "teach" || c.kind === "practice");
			assert.ok(Number.isInteger(c.messageCount) && (c.messageCount as number) >= 0);
			assert.ok(c.phase === "probe" || c.phase === "plan" || c.phase === "teach");
			assert.equal(typeof c.busy, "boolean");
			assert.equal(typeof c.compacting, "boolean");
		}
		const byId = new Map(parseChatList(body).map((c) => [c.id, c]));
		assert.deepEqual([byId.get(teachId)?.title, byId.get(teachId)?.kind, byId.get(teachId)?.messageCount], [TEACH_TITLE, "teach", 4]);
		assert.deepEqual([byId.get(practiceId)?.kind, byId.get(practiceId)?.messageCount], ["practice", 2]);
		assert.equal(byId.get(emptyId)?.messageCount, 0);
	});
});

describe("GET /api/chats/:id/markdown (session text, consent only)", { timeout: 120_000 }, () => {
	it("answers 200 text/markdown as an attachment named from the title", async () => {
		const res = await get(`/api/chats/${encodeURIComponent(teachId)}/markdown`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "text/markdown; charset=utf-8");
		const disposition = res.headers.get("content-disposition") ?? "";
		assert.ok(disposition.startsWith("attachment;"));
		assert.ok(disposition.includes('filename="teach-me-to-decode-a-metar.md"'));
		const body = await res.text();
		assert.ok(body.startsWith(`# ${TEACH_TITLE}`), "the title heads the document");
		assert.ok(body.includes("### Learner"), "learner blocks");
		assert.ok(body.includes("### Teacher"), "teacher blocks");
		assert.ok(body.includes("Teach me to decode a METAR"), "the session text is there");
	});

	it("answers 404 JSON for an unknown session", async () => {
		const res = await get("/api/chats/chat_nope/markdown");
		assert.equal(res.status, 404);
		const body = (await res.json()) as { error?: unknown };
		assert.equal(typeof body.error, "string");
	});
});

describe("GET /api/chats/:id (plan tree and messages, for the record)", { timeout: 120_000 }, () => {
	it("answers 200 with the plan tree and the native messages", async () => {
		const res = await get(`/api/chats/${encodeURIComponent(teachId)}`);
		assert.equal(res.status, 200);
		const rec = parseChatRecord(await res.json());
		assert.equal(rec.id, teachId);
		assert.equal(rec.title, TEACH_TITLE);
		assert.deepEqual(rec.tree?.nodes.map((nd) => nd.title), ["Station identifier", "Wind group", "Visibility"]);
		assert.equal(rec.messages.length, 4);
		assert.deepEqual(planProgress(rec.tree!, rec.messages), {
			topics: [
				{ title: "Station identifier", status: "covered" },
				{ title: "Wind group", status: "in-progress" },
				{ title: "Visibility", status: "not-yet" },
			],
			total: 3,
			covered: 1,
			current: "Wind group",
		});
	});

	it("answers 404 for an unknown session", async () => {
		const res = await get("/api/chats/chat_nope");
		assert.equal(res.status, 404);
		await res.arrayBuffer();
	});
});

describe("GET /api/graph (facts learned, for the record)", { timeout: 120_000 }, () => {
	it("answers 200 with propositions, their provenance, session titles and notes files", async () => {
		const res = await get("/api/graph");
		assert.equal(res.status, 200);
		const graph = parseGraph(await res.json());
		const byId = new Map(graph.propositions.map((p) => [p.id, p]));
		assert.equal(byId.get("n_wind_true")?.statement, "METAR wind direction is referenced to true north.");
		assert.equal(byId.get("n_wind_true")?.provenance[0]?.chatId, teachId);
		assert.equal(byId.get("n_vref")?.provenance[0]?.chatId, SRC_ID);
		assert.equal(graph.sessions[teachId], TEACH_TITLE);
		assert.equal(graph.fileSources[SRC_ID], "uploads/pa28-notes.md");
	});
});

describe("the study record, end to end against the real server", { timeout: 120_000 }, () => {
	it("fetches read-only, builds, and renders the record", async () => {
		const src = await fetchRecordSource(server.url);
		assert.deepEqual(Object.keys(src.records).sort(), [practiceId, teachId].sort(), "empty sessions are not fetched");
		const rec = buildStudyRecord(src, {
			studentName: "Pat Lee",
			printedAt: new Date("2026-11-08T18:00:00Z"),
			timeZone: "America/Los_Angeles",
			activeSecondsBySession: { [teachId]: 2700 },
		});
		assert.deepEqual(rec.sessions.map((s) => [s.title, s.kind, s.activeSeconds]), [
			[TEACH_TITLE, "teach", 2700],
			["METAR drill", "practice", null],
		]);
		assert.equal(rec.sessions[0]!.plan?.current, "Wind group");
		assert.deepEqual(rec.learned.sessionGroups.map((g) => [g.heading, g.facts.map((f) => f.name)]), [
			[TEACH_TITLE, ["Wind direction is true", "Visibility in statute miles"]],
		]);
		assert.deepEqual(rec.learned.notesGroups.map((g) => [g.heading, g.facts.map((f) => f.name)]), [["pa28-notes.md", ["Vref"]]]);
		const html = renderStudyRecordHtml(rec);
		assert.ok(html.split(RECORD_LABEL).length - 1 >= 2, "label at the top and the bottom");
	});
});
