/**
 * P1-08 (C1 req 6, D20, D25): the student's data export zip.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECORD_LABEL } from "../frontdoor/records/index.ts";
import { buildExport, buildRecordHtml, slugify } from "../frontdoor/retention/export.ts";
import { createZip } from "../frontdoor/retention/zip.ts";
import { CHAT_A, fakeTenantFetch, fakeUpstreamAnswers, readZip } from "./frontdoor-retention-helpers.ts";

const NOW = new Date("2026-11-08T12:34:56Z");
const TENANT = "11111111-2222-4333-8444-555555555555";

describe("the zip writer", () => {
	it("writes files another reader opens, with UTF-8 names, deflate and stored entries", () => {
		const big = "METAR KSFO 081756Z ".repeat(500);
		const zip = createZip(
			[
				{ name: "a.txt", data: big },
				{ name: "dir/ü-ñ.md", data: "x" },
				{ name: "empty.json", data: Buffer.alloc(0) },
			],
			NOW,
		);
		const files = readZip(zip);
		assert.deepEqual([...files.keys()], ["a.txt", "dir/ü-ñ.md", "empty.json"]);
		assert.equal(files.get("a.txt")!.data.toString(), big);
		assert.equal(files.get("a.txt")!.method, 8, "compressible text is deflated");
		assert.equal(files.get("dir/ü-ñ.md")!.method, 0, "a tiny file is stored");
		assert.equal(files.get("dir/ü-ñ.md")!.flags & 0x0800, 0x0800, "UTF-8 name flag");
		assert.equal(files.get("empty.json")!.data.length, 0);
	});

	it("refuses names that could climb out of the folder, and duplicate names", () => {
		for (const name of ["/etc/passwd", "../x", "a/../../b", "a\\b", "", "a//b", "./a"]) {
			assert.throws(() => createZip([{ name, data: "x" }]), /zip entry/, name);
		}
		assert.throws(() => createZip([{ name: "a", data: "1" }, { name: "a", data: "2" }]), /share the name/);
	});
});

describe("the export (C1 req 6)", () => {
	const inputs = (fetchTenant: ReturnType<typeof fakeTenantFetch>["fetchTenant"]) => ({
		tenantId: TENANT,
		fetchTenant,
		studentName: "Pat Pilot",
		timeZone: "America/Los_Angeles",
		activeSecondsBySession: { [CHAT_A]: 2700 },
		now: NOW,
	});

	it("holds the sessions as markdown, the record, the graph and the imported notes", async () => {
		const answers = fakeUpstreamAnswers();
		const { fetchTenant, seen } = fakeTenantFetch(answers);
		const result = await buildExport(inputs(fetchTenant));
		assert.equal(result.fileName, "ground-tutor-data-2026-11-08.zip");
		assert.deepEqual(result.missing, []);
		assert.equal(result.sessions, 2);
		const files = readZip(result.body);
		assert.deepEqual([...files.keys()], [
			"README.txt",
			"sessions/001-2026-11-01-decode-a-metar.md",
			"sessions/002-2026-11-03-class-b-airspace.md",
			"study-record.html",
			"knowledge-graph.json",
			"imported-notes.json",
		]);
		assert.equal(files.get("sessions/001-2026-11-01-decode-a-metar.md")!.data.toString(), answers[`/api/chats/${CHAT_A}/markdown`]);
		assert.deepEqual(JSON.parse(files.get("knowledge-graph.json")!.data.toString()), answers["/api/graph"]);
		assert.deepEqual(JSON.parse(files.get("imported-notes.json")!.data.toString()), answers["/api/graph/sources"]);
		const record = files.get("study-record.html")!.data.toString();
		assert.ok(record.includes(RECORD_LABEL), "the record carries the N8 label");
		assert.ok(record.includes("Pat Pilot"));
		assert.ok(record.includes("45 min"), "front door active time per session");
		const readme = files.get("README.txt")!.data.toString();
		assert.ok(readme.includes(RECORD_LABEL));
		assert.ok(readme.includes("info@flynorthaero.com"));
		assert.ok(!readme.includes("could not be included"));
		assert.ok(seen.every((p) => p.startsWith("/api/")), "only upstream API reads");
	});

	it("leaves out a part that fails and names it in README.txt", async () => {
		const { fetchTenant } = fakeTenantFetch(fakeUpstreamAnswers(), new Set(["/api/graph/sources", `/api/chats/${CHAT_A}/markdown`]));
		const result = await buildExport(inputs(fetchTenant));
		assert.deepEqual(result.missing.sort(), ["imported-notes.json", "sessions/001-2026-11-01-decode-a-metar.md"]);
		const files = readZip(result.body);
		assert.ok(!files.has("imported-notes.json"));
		const readme = files.get("README.txt")!.data.toString();
		assert.ok(readme.includes("imported-notes.json"));
		assert.ok(readme.includes("sessions/001-2026-11-01-decode-a-metar.md"));
	});

	it("fails when the session list does not answer", async () => {
		const { fetchTenant } = fakeTenantFetch(fakeUpstreamAnswers(), new Set(["/api/chats"]));
		await assert.rejects(buildExport(inputs(fetchTenant)), /500/);
	});

	it("builds the printable record on its own, in the given time zone", async () => {
		const { fetchTenant } = fakeTenantFetch(fakeUpstreamAnswers());
		const html = await buildRecordHtml(inputs(fetchTenant));
		assert.ok(html.startsWith("<!doctype html>") || html.toLowerCase().startsWith("<!doctype html>"));
		assert.ok(html.includes(RECORD_LABEL));
	});

	it("slugs titles like upstream, never empty", () => {
		assert.equal(slugify("Decode a METAR!"), "decode-a-metar");
		assert.equal(slugify("???"), "session");
		assert.ok(slugify("x".repeat(200)).length <= 60);
	});
});
