/**
 * P3-05: the non-aviation flag (C7 req 4, N7; C7 acceptance test "A seeded
 * cooking session is flagged. A seeded METAR session is not.").
 *
 * After a session ends, Haiku labels its topic from the session title and
 * plan topics only, never session text. Here a fake Anthropic server on
 * 127.0.0.1 stands in for Haiku: it answers "other" for a cooking topic and
 * "aviation" for a METAR topic, and records exactly what it was sent.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { FLAG_MODEL, FLAG_SYSTEM_PROMPT, flagUserPrompt, haikuClassifier, labelEndedSessions } from "../frontdoor/admin/flags.ts";
import * as dbm from "../frontdoor/db/index.ts";
import { createStudyTimeRecorder } from "../frontdoor/study-time/index.ts";
import { type Fixture, startFixture } from "./frontdoor-admin-fixture.ts";

const PRIVATE = "the student's own words that must never reach the labeler";
let f: Fixture;
let anthropic: Server;
let anthropicUrl = "";
const sent: Array<{ headers: Record<string, string | string[] | undefined>; body: { model: string; system: string; max_tokens: number; messages: Array<{ content: string }> } }> = [];
let answer: (prompt: string) => string = (prompt) => (/METAR|airspace|weather|wind/i.test(prompt) ? "aviation" : "other");

before(async () => {
	anthropic = createServer((req, res) => {
		let raw = "";
		req.on("data", (c: Buffer) => (raw += c.toString()));
		req.on("end", () => {
			const body = JSON.parse(raw) as (typeof sent)[number]["body"];
			sent.push({ headers: req.headers, body });
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify({ content: [{ type: "text", text: answer(body.messages[0]?.content ?? "") }] }));
		});
	});
	await new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", r));
	anthropicUrl = `http://127.0.0.1:${(anthropic.address() as AddressInfo).port}`;
	f = await startFixture();
});
after(async () => {
	await f.close();
	await new Promise((r) => anthropic.close(r));
});

async function studied(tenantId: string, chatId: string, at: number) {
	const rec = createStudyTimeRecorder({ db: f.db, now: () => at });
	await rec.beat(tenantId, chatId);
}

describe("labeling ended sessions", () => {
	let cook: { tenantId: string };
	let pilot: { tenantId: string };
	const classifier = () => haikuClassifier({ apiKey: "sk-ant-front-door-key", baseUrl: anthropicUrl });

	before(async () => {
		cook = await f.student("flag_cook");
		pilot = await f.student("flag_pilot");
		f.chats.set(cook.tenantId, [{ id: "chat_cook_1", title: "Baking sourdough bread", topics: ["Starter", "Proofing", "Scoring the loaf"], markdown: PRIVATE }]);
		f.chats.set(pilot.tenantId, [{ id: "chat_metar_1", title: "Decoding a METAR", topics: ["Wind", "Visibility", "Sky condition"], markdown: PRIVATE }]);
		const start = f.clock.now - 3600_000;
		await studied(cook.tenantId, "chat_cook_1", start);
		await studied(pilot.tenantId, "chat_metar_1", start);
	});

	it("waits until the session has ended (30 minutes without study)", async () => {
		const early = await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: classifier(), now: () => new Date(f.clock.now - 3600_000 + 10 * 60_000) });
		assert.deepEqual(early, { labeled: 0, nonAviation: 0, skipped: 0 });
		assert.equal(sent.length, 0);
	});

	it("flags the seeded cooking session, and not the seeded METAR session", async () => {
		const run = await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: classifier(), now: () => new Date(f.clock.now) });
		assert.deepEqual(run, { labeled: 2, nonAviation: 1, skipped: 0 });
		const cookLabel = await dbm.getTopicLabel(f.db, cook.tenantId, "chat_cook_1");
		const metarLabel = await dbm.getTopicLabel(f.db, pilot.tenantId, "chat_metar_1");
		assert.equal(cookLabel?.isAviation, false);
		assert.equal(metarLabel?.isAviation, true);
		assert.equal(metarLabel?.model, FLAG_MODEL);
		assert.equal(metarLabel?.topic, "Decoding a METAR | Wind; Visibility; Sky condition");
	});

	it("sent Haiku only the title and plan topics, with the front door's key", () => {
		assert.equal(sent.length, 2);
		for (const s of sent) {
			assert.equal(s.body.model, "claude-haiku-5-5");
			assert.equal(s.body.system, FLAG_SYSTEM_PROMPT);
			assert.equal(s.body.max_tokens, 5);
			assert.equal(s.headers["x-api-key"], "sk-ant-front-door-key");
			assert.doesNotMatch(JSON.stringify(s.body), /must never reach the labeler/);
		}
		assert.equal(sent.find((s) => s.body.messages[0]?.content.includes("sourdough"))?.body.messages[0]?.content, flagUserPrompt({ title: "Baking sourdough bread", topics: ["Starter", "Proofing", "Scoring the loaf"] }));
		assert.ok(f.tenantHits.every(([, p]) => !p.endsWith("/markdown")), "session text was never fetched");
	});

	it("labels each session once, until it is studied again", async () => {
		sent.length = 0;
		assert.equal((await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: classifier(), now: () => new Date(f.clock.now) })).labeled, 0);
		await studied(cook.tenantId, "chat_cook_1", f.clock.now + 60_000);
		const run = await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: classifier(), now: () => new Date(f.clock.now + 40 * 60_000) });
		assert.equal(run.labeled, 1);
	});

	it("shows on the dashboard", async () => {
		const res = await fetch(`${f.base}/admin/api/overview?period=all`, { headers: { Cookie: await f.cookie(f.owner.clerkUserId) } });
		const o = (await res.json()) as { rows: Array<{ tenantId: string; nonAviationSessions: number; recentTopics: string[] }>; totals: { nonAviationSessions: number } };
		const row = o.rows.find((r) => r.tenantId === cook.tenantId);
		assert.equal(row?.nonAviationSessions, 1);
		assert.deepEqual(row?.recentTopics, ["Baking sourdough bread"]);
		assert.equal(o.rows.find((r) => r.tenantId === pilot.tenantId)?.nonAviationSessions, 0);
		assert.equal(o.totals.nonAviationSessions, 1);
	});
});

describe("when labeling cannot finish", () => {
	it("an unclear answer stores nothing and is tried again later", async () => {
		const s = await f.student("flag_unclear");
		f.chats.set(s.tenantId, [{ id: "chat_u_1", title: "Something", topics: [], markdown: PRIVATE }]);
		await studied(s.tenantId, "chat_u_1", f.clock.now - 3600_000);
		answer = () => "I am not sure";
		const c = haikuClassifier({ apiKey: "k", baseUrl: anthropicUrl });
		const run = await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: c, now: () => new Date(f.clock.now) });
		assert.equal(await dbm.getTopicLabel(f.db, s.tenantId, "chat_u_1"), null);
		assert.ok(run.skipped >= 1);
		answer = () => "Aviation.";
		await labelEndedSessions({ db: f.db, tenantFetch: tenantFetchOf(f), classifier: c, now: () => new Date(f.clock.now) });
		assert.equal((await dbm.getTopicLabel(f.db, s.tenantId, "chat_u_1"))?.isAviation, true);
	});

	it("a tenant server that does not answer is skipped, and the log names no topic", async () => {
		const s = await f.student("flag_down");
		await studied(s.tenantId, "chat_missing", f.clock.now - 3600_000);
		const logs: string[] = [];
		const run = await labelEndedSessions({
			db: f.db,
			tenantFetch: tenantFetchOf(f),
			classifier: haikuClassifier({ apiKey: "k", baseUrl: anthropicUrl }),
			now: () => new Date(f.clock.now),
			log: (l) => logs.push(l),
		});
		assert.ok(run.skipped >= 1);
		assert.ok(logs.some((l) => l.includes("chat_missing")));
		assert.equal(await dbm.getTopicLabel(f.db, s.tenantId, "chat_missing"), null);
	});
});

/** The fixture's stand-in tenant servers, as a TenantFetch. */
function tenantFetchOf(fx: Fixture) {
	return async (tenantId: string, p: string) => {
		fx.tenantHits.push([tenantId, p]);
		const chat = (fx.chats.get(tenantId) ?? []).find((c) => p === `/api/chats/${c.id}`);
		if (!chat) return new Response("missing", { status: 404 });
		return Response.json({
			id: chat.id,
			title: chat.title,
			createdAt: "2026-11-08T10:00:00.000Z",
			updatedAt: "2026-11-08T10:00:00.000Z",
			tree: { nodes: chat.topics.map((title, i) => ({ id: `n${i}`, title })), edges: [], version: 1 },
			messages: [{ role: "user", content: chat.markdown }],
		});
	};
}
